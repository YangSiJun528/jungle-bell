import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestHarness, unstable_splitSqlQuery, type TestHarness } from "wrangler";
import { runLaundryLifecycle } from "../../jobs-runner/src/services/laundry-lifecycle-service";
import { D1RenewalStore } from "../../../shared/persistence/d1-renewal-store";
import { hashAppSessionToken } from "../../../shared/renewal/crypto";
import type { ApiBindings } from "../src/controllers/types";

const workerRoot = fileURLToPath(new URL("..", import.meta.url));
const schemaPath = fileURLToPath(new URL("../../../database/schema.sql", import.meta.url));

describe("API Worker in the official Wrangler test harness", () => {
  let harness: TestHarness;

  beforeAll(async () => {
    harness = createTestHarness({
      root: workerRoot,
      workers: [{ configPath: "deploy/wrangler.test.jsonc" }],
    });
    await harness.listen();
    const worker = harness.getWorker<ApiBindings>();
    const environment = await worker.getEnv();
    const schema = unstable_splitSqlQuery(await readFile(schemaPath, "utf8"));
    await environment.DB.batch(schema.map((sql) => environment.DB.prepare(sql)));
  }, 30_000);

  afterAll(async () => {
    await harness.close();
  });

  it("runs the current health route against real workerd, D1, and R2 bindings", async () => {
    const worker = harness.getWorker<ApiBindings>();
    const environment = await worker.getEnv();

    await expect(environment.DB.prepare("SELECT count(*) AS count FROM source_state").first<number>("count"))
      .resolves.toBe(0);
    await expect(environment.DATA_BUCKET.put("harness-check", "ready")).resolves.toBeDefined();
    await expect(environment.DATA_BUCKET.get("harness-check")).resolves.toMatchObject({ key: "harness-check" });

    const response = await worker.fetch("/api/health");
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ status: "DEGRADED", sources: [] });
  });

  it("issues, authenticates, persists, and explicitly revokes an origin-bound desktop UI session", async () => {
    const worker = harness.getWorker<ApiBindings>();
    const environment = await worker.getEnv();
    const now = Date.now();
    const desktopToken = `jbd_${"a".repeat(64)}`;
    await environment.DB.batch([
      environment.DB.prepare("INSERT INTO app_user (id, created_at_epoch_ms) VALUES ('harness-ui-user', ?)")
        .bind(now),
      environment.DB.prepare(`INSERT INTO desktop_device (installation_id, user_id, created_at_epoch_ms,
        last_seen_at_epoch_ms, lms_session_state, app_version)
        VALUES ('harness-ui-desktop', 'harness-ui-user', ?, ?, 'connected', '0.5.0')`).bind(now, now),
      environment.DB.prepare(`INSERT INTO app_session (id, user_id, installation_id, kind, label, token_sha256,
        created_at_epoch_ms, expires_at_epoch_ms, last_seen_at_epoch_ms, revoked_at_epoch_ms, source_pairing_id)
        VALUES ('harness-ui-parent', 'harness-ui-user', 'harness-ui-desktop', 'desktop', NULL, ?, ?, ?, ?, NULL, NULL)`)
        .bind(await hashAppSessionToken(desktopToken), now, now + 60_000, now),
    ]);

    const bootstrap = await worker.fetch("/api/desktop/webview-sessions", {
      method: "POST",
      headers: { authorization: `Bearer ${desktopToken}`, "content-type": "application/json" },
      body: JSON.stringify({ origin: "tauri://localhost" }),
    });
    expect(bootstrap.status).toBe(201);
    const issued = await bootstrap.json() as { accessToken: string; expiresAt: string };
    expect(issued).toEqual({
      accessToken: expect.stringMatching(/^jbui_[a-f0-9]{64}$/u),
      expiresAt: expect.stringMatching(/Z$/u),
    });
    await expect(environment.DB.prepare(`SELECT token_sha256, origin, scope FROM desktop_ui_session
      WHERE parent_session_id = 'harness-ui-parent'`).first()).resolves.toEqual({
      token_sha256: await hashAppSessionToken(issued.accessToken),
      origin: "tauri://localhost",
      scope: "desktop-ui-v1",
    });

    const attendance = await worker.fetch("/api/desktop-ui/attendance", {
      headers: { authorization: `Bearer ${issued.accessToken}`, origin: "tauri://localhost" },
    });
    expect(attendance.status).toBe(200);

    const revoke = await worker.fetch("/api/desktop/webview-sessions/current", {
      method: "DELETE",
      headers: { authorization: `Bearer ${desktopToken}`, "content-type": "application/json" },
      body: JSON.stringify({ origin: "tauri://localhost" }),
    });
    expect(revoke.status).toBe(204);
    expect((await worker.fetch("/api/desktop-ui/attendance", {
      headers: { authorization: `Bearer ${issued.accessToken}`, origin: "tauri://localhost" },
    })).status).toBe(401);
  });

  it("atomically completes an availability watch, inserts its notification, and fans out to the active desktop", async () => {
    const worker = harness.getWorker<ApiBindings>();
    const environment = await worker.getEnv();
    const now = Date.parse("2026-08-10T03:00:00.000Z");
    await environment.DB.batch([
      environment.DB.prepare("INSERT INTO app_user (id, created_at_epoch_ms) VALUES ('user-1', ?)")
        .bind(now),
      environment.DB.prepare(`INSERT INTO desktop_device (installation_id, user_id, created_at_epoch_ms,
        last_seen_at_epoch_ms, lms_session_state, app_version)
        VALUES ('desktop-1', 'user-1', ?, ?, 'connected', '0.5.0')`).bind(now, now),
      environment.DB.prepare(`INSERT INTO app_session (id, user_id, installation_id, kind, label, token_sha256,
        created_at_epoch_ms, expires_at_epoch_ms, last_seen_at_epoch_ms, revoked_at_epoch_ms, source_pairing_id)
        VALUES ('desktop-session', 'user-1', 'desktop-1', 'desktop', NULL, ?, ?, ?, ?, NULL, NULL)`)
        .bind("4".repeat(64), now, now + 60_000, now),
      environment.DB.prepare(`INSERT INTO laundry_watch
        (id, user_id, machine_id, appliance, session_id, notify_before_minutes,
          notify_when_available, status, created_at_epoch_ms, updated_at_epoch_ms)
        VALUES ('watch-1', 'user-1', 'tower-3', 'washer', NULL, 0, 1, 'active', ?, ?)`)
        .bind(now - 1_000, now - 1_000),
      environment.DB.prepare(`INSERT INTO laundry_event (id, machine_id, appliance, session_id, type,
        previous_observed_at, observed_at, eta_delta_minutes, previous_state, current_state, detail_json)
        VALUES ('event-1', 'tower-3', 'washer', NULL, 'STATE_CHANGED', ?, ?, NULL, 'RUNNING', 'POWER_OFF', '{}')`)
        .bind(new Date(now - 1_000).toISOString(), new Date(now).toISOString()),
    ]);

    const store = new D1RenewalStore(environment.DB);
    const projectedStorage = {
      readState: async () => ({
        source: "laundry" as const, lastAttemptAt: new Date(now).toISOString(),
        lastSuccessAt: new Date(now).toISOString(), lastResponseSha: "9".repeat(64),
        lastRawKey: "raw", lastNormalizedKey: "normalized", versionFirstSeenAt: new Date(now).toISOString(),
        consecutiveFailures: 0, lastError: null,
      }),
      readJson: async <T>() => ({
        schemaVersion: 1, sourceVersionSha: "9".repeat(64), observedAt: new Date(now).toISOString(),
        machines: [{ id: "tower-3", washer: {
          machineId: "tower-3", appliance: "washer", observedAt: new Date(now).toISOString(),
          state: { code: "POWER_OFF", raw: "POWER_OFF", known: true }, operationalStatus: "IDLE",
          remainingMinutes: 0, totalMinutes: 0, startedAt: new Date(now).toISOString(),
          estimatedFinishAt: null, remoteControlEnabled: false, cycleCount: 1, sessionId: null, errorCode: null,
        }, dryer: null }], events: [], unknownEnums: [],
      }) as T,
    };

    await expect(runLaundryLifecycle(store, projectedStorage, now)).resolves.toEqual({
      processedEvents: 1, notifications: 1,
    });
    await expect(environment.DB.prepare(
      "SELECT status, updated_at_epoch_ms FROM laundry_watch WHERE id = 'watch-1'",
    ).first()).resolves.toEqual({ status: "completed", updated_at_epoch_ms: now });
    const notification = await environment.DB.prepare(
      "SELECT id, user_id, source_event_id FROM notification WHERE user_id = 'user-1'",
    ).first<{ id: string; user_id: string; source_event_id: string }>();
    expect(notification?.user_id).toBe("user-1");
    expect(notification?.source_event_id).toMatch(/^laundry-available:laundry-projection:/u);
    await expect(environment.DB.prepare(
      "SELECT target_kind, target_id FROM notification_delivery WHERE notification_id = ?",
    ).bind(notification!.id).all()).resolves.toMatchObject({
      results: [{ target_kind: "desktop", target_id: "desktop-1" }],
    });
    await expect(environment.DB.prepare(
      "SELECT source_id FROM laundry_lifecycle_processing WHERE source_id = 'event-1'",
    ).all()).resolves.toMatchObject({ results: [{ source_id: "event-1" }] });
    await expect(runLaundryLifecycle(store, projectedStorage, now + 1)).resolves.toEqual({
      processedEvents: 0, notifications: 0,
    });
  });
});
