import { afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../../apps/api-worker/src/index";
import { DESKTOP_UI_SESSION_TTL_MS } from "../../apps/api-worker/src/services/desktop-ui-session-service";
import { MemoryRenewalStore } from "../../shared/tests/helpers/memory-renewal-store";

const NOW = Date.parse("2026-08-12T00:00:00.000Z");
const SECRET = "test-pairing-secret-that-is-at-least-32-bytes";
const UI_ORIGIN = "tauri://localhost";

afterEach(() => vi.useRealTimers());

function environment(store: MemoryRenewalStore) {
  return {
    DB: {} as D1Database,
    DATA_BUCKET: {} as R2Bucket,
    PAIRING_SECRET: SECRET,
    RENEWAL_STORE: store,
  };
}

async function enroll(store: MemoryRenewalStore) {
  const response = await app.request("https://app.test/api/desktop/installations", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://app.test" },
    body: JSON.stringify({ installationId: "desktop-ui-test-installation" }),
  }, environment(store));
  expect(response.status).toBe(201);
  return response.json<{ accessToken: string }>();
}

async function bootstrap(store: MemoryRenewalStore, desktopToken: string, origin = UI_ORIGIN) {
  return app.request("https://app.test/api/desktop/webview-sessions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${desktopToken}`,
      "content-type": "application/json",
      origin: "https://app.test",
    },
    body: JSON.stringify({ origin }),
  }, environment(store));
}

function uiRequest(
  store: MemoryRenewalStore,
  path: string,
  token: string,
  init: RequestInit = {},
  origin: string | null = UI_ORIGIN,
) {
  return app.request(`https://app.test${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(origin === null ? {} : { origin }),
      ...init.headers,
    },
  }, environment(store));
}

describe("desktop UI HTTP boundary", () => {
  it("bootstraps only from a long desktop bearer and replaces the prior token", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const store = new MemoryRenewalStore();
    const desktop = await enroll(store);
    const firstResponse = await bootstrap(store, desktop.accessToken);
    expect(firstResponse.status).toBe(201);
    const first = await firstResponse.json<{ accessToken: string; expiresAt: string }>();
    expect(first).toEqual({
      accessToken: expect.stringMatching(/^jbui_[a-f0-9]{64}$/u),
      expiresAt: new Date(NOW + DESKTOP_UI_SESSION_TTL_MS).toISOString(),
    });
    expect(first.accessToken).toMatch(/^jbui_[a-f0-9]{64}$/u);

    const secondResponse = await bootstrap(store, desktop.accessToken);
    const second = await secondResponse.json<{ accessToken: string }>();
    expect(second.accessToken).not.toBe(first.accessToken);
    expect((await uiRequest(store, "/api/desktop-ui/attendance", first.accessToken)).status).toBe(401);
    expect((await uiRequest(store, "/api/desktop-ui/attendance", second.accessToken)).status).toBe(200);

    expect((await bootstrap(store, second.accessToken)).status).toBe(401);
    expect((await uiRequest(store, "/api/desktop-ui/attendance", desktop.accessToken)).status).toBe(401);
  });

  it("binds the token to an exact allowlisted origin and emits strict CORS", async () => {
    const store = new MemoryRenewalStore();
    const desktop = await enroll(store);
    expect((await bootstrap(store, desktop.accessToken, "null")).status).toBe(400);
    expect((await bootstrap(store, desktop.accessToken, "https://evil.test")).status).toBe(400);
    const issued = await (await bootstrap(store, desktop.accessToken)).json<{ accessToken: string }>();

    expect((await uiRequest(store, "/api/desktop-ui/attendance", issued.accessToken)).status).toBe(200);
    expect((await uiRequest(store, "/api/desktop-ui/attendance", issued.accessToken, {}, "http://tauri.localhost")).status).toBe(403);
    expect((await uiRequest(store, "/api/desktop-ui/attendance", issued.accessToken, {}, "null")).status).toBe(403);
    expect((await uiRequest(store, "/api/desktop-ui/attendance", issued.accessToken, {}, null)).status).toBe(403);

    for (const origin of [UI_ORIGIN, "http://tauri.localhost", "http://127.0.0.1:5173"]) {
      const response = await app.request("https://app.test/api/desktop-ui/attendance", {
        method: "OPTIONS",
        headers: { origin, "access-control-request-method": "GET" },
      }, environment(store));
      expect(response.headers.get("access-control-allow-origin")).toBe(origin);
      expect(response.headers.get("access-control-allow-credentials")).toBeNull();
    }
    for (const origin of ["null", "https://evil.test"]) {
      const response = await app.request("https://app.test/api/desktop-ui/attendance", {
        method: "OPTIONS",
        headers: { origin, "access-control-request-method": "GET" },
      }, environment(store));
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    }
  });

  it("expires absolutely and fails immediately when the parent rotates or is revoked", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const store = new MemoryRenewalStore();
    const desktop = await enroll(store);
    const issued = await (await bootstrap(store, desktop.accessToken)).json<{ accessToken: string }>();

    vi.setSystemTime(NOW + DESKTOP_UI_SESSION_TTL_MS);
    expect((await uiRequest(store, "/api/desktop-ui/attendance", issued.accessToken)).status).toBe(401);

    vi.setSystemTime(NOW + 1);
    const replacement = await (await bootstrap(store, desktop.accessToken)).json<{ accessToken: string }>();
    const rotatedResponse = await app.request("https://app.test/api/desktop/installations/rotate", {
      method: "POST",
      headers: { authorization: `Bearer ${desktop.accessToken}`, "content-type": "application/json", origin: "https://app.test" },
      body: JSON.stringify({}),
    }, environment(store));
    expect(rotatedResponse.status).toBe(200);
    expect((await uiRequest(store, "/api/desktop-ui/attendance", replacement.accessToken)).status).toBe(401);

    const rotated = await rotatedResponse.json<{ accessToken: string }>();
    const afterRotate = await (await bootstrap(store, rotated.accessToken)).json<{ accessToken: string }>();
    const parent = [...store.sessions.values()].find((session) => session.tokenSha256
      === [...store.sessions.values()].find((session) => session.revokedAtEpochMs === null)?.tokenSha256)!;
    store.sessions.set(parent.id, { ...parent, revokedAtEpochMs: NOW + 2 });
    expect((await uiRequest(store, "/api/desktop-ui/attendance", afterRotate.accessToken)).status).toBe(401);
  });

  it("supports explicit best-effort revoke and keeps UI tokens out of long-bearer routes", async () => {
    const store = new MemoryRenewalStore();
    const desktop = await enroll(store);
    const issued = await (await bootstrap(store, desktop.accessToken)).json<{ accessToken: string }>();
    const wrongOriginRevoke = await app.request("https://app.test/api/desktop/webview-sessions/current", {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${desktop.accessToken}`,
        "content-type": "application/json",
        origin: "https://app.test",
      },
      body: JSON.stringify({ origin: "http://tauri.localhost" }),
    }, environment(store));
    expect(wrongOriginRevoke.status).toBe(204);
    expect((await uiRequest(store, "/api/desktop-ui/attendance", issued.accessToken)).status).toBe(200);

    const invalidRevoke = await app.request("https://app.test/api/desktop/webview-sessions/current", {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${desktop.accessToken}`,
        "content-type": "application/json",
        origin: "https://app.test",
      },
      body: JSON.stringify({ origin: UI_ORIGIN, all: true }),
    }, environment(store));
    expect(invalidRevoke.status).toBe(400);

    const revoked = await app.request("https://app.test/api/desktop/webview-sessions/current", {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${desktop.accessToken}`,
        "content-type": "application/json",
        origin: "https://app.test",
      },
      body: JSON.stringify({ origin: UI_ORIGIN }),
    }, environment(store));
    expect(revoked.status).toBe(204);
    expect((await uiRequest(store, "/api/desktop-ui/attendance", issued.accessToken)).status).toBe(401);

    const heartbeat = await uiRequest(store, "/api/desktop/heartbeat", issued.accessToken, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://app.test" },
      body: JSON.stringify({ lmsSessionState: "unknown", appVersion: null }),
    });
    expect(heartbeat.status).toBe(401);
  });

  it("mirrors only the approved account routes in the desktop-ui namespace", async () => {
    const store = new MemoryRenewalStore();
    const desktop = await enroll(store);
    const issued = await (await bootstrap(store, desktop.accessToken)).json<{ accessToken: string }>();
    const json = (method: string, body: unknown): RequestInit => ({
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    const cases: Array<[string, RequestInit, number]> = [
      ["/api/desktop-ui/attendance", {}, 200],
      ["/api/desktop-ui/v2/attendance/preferences", {}, 200],
      ["/api/desktop-ui/v2/attendance/preferences", json("PUT", {
        enabled: true, morning: true, evening: true, morningStartHour: 9, eveningEndHour: 4,
        morningIntervalMinutes: 15, eveningIntervalMinutes: 15, skipSunday: false, skipAttendanceDate: null,
      }), 200],
      ["/api/desktop-ui/meal-preferences", {}, 200],
      ["/api/desktop-ui/meal-preferences", json("PUT", {
        enabled: true, lunch: true, dinner: true,
      }), 200],
      ["/api/desktop-ui/laundry-watches", {}, 200],
      ["/api/desktop-ui/laundry-watches", json("POST", {
        machineId: "tower-3", appliance: "washer", sessionId: null,
        notifyBeforeMinutes: 5, notifyWhenAvailable: true,
      }), 201],
      ["/api/desktop-ui/mobile-sessions", {}, 200],
      ["/api/desktop-ui/pairings", json("POST", {}), 201],
    ];
    for (const [path, init, status] of cases) {
      expect((await uiRequest(store, path, issued.accessToken, init)).status, `${init.method ?? "GET"} ${path}`).toBe(status);
    }

    const watchId = [...store.laundryWatches.keys()][0]!;
    expect((await uiRequest(store, `/api/desktop-ui/laundry-watches/${watchId}`, issued.accessToken, {
      method: "DELETE",
    })).status).toBe(204);
    const pairingId = [...store.pairings.keys()][0]!;
    expect((await uiRequest(store, `/api/desktop-ui/pairings/${pairingId}`, issued.accessToken)).status).toBe(200);
    expect((await uiRequest(store, `/api/desktop-ui/pairings/${pairingId}/approve`, issued.accessToken,
      json("POST", { claimId: `jbp_${crypto.randomUUID()}` }))).status).toBe(409);
    expect((await uiRequest(store, `/api/desktop-ui/pairings/${pairingId}/approve`, issued.accessToken,
      json("POST", { claimId: pairingId }))).status).toBe(409);

    const mobileSessionId = `jbsi_${crypto.randomUUID()}`;
    const parent = [...store.sessions.values()].find((session) => session.kind === "desktop")!;
    store.sessions.set(mobileSessionId, {
      ...parent,
      id: mobileSessionId,
      installationId: "jbmi_0123456789abcdef0123456789abcdef",
      kind: "mobile",
      label: "테스트 폰",
      tokenSha256: "f".repeat(64),
      sourcePairingId: null,
    });
    expect((await uiRequest(store, "/api/desktop-ui/mobile-sessions", issued.accessToken)).status).toBe(200);
    expect((await uiRequest(store, `/api/desktop-ui/mobile-sessions/${mobileSessionId}`, issued.accessToken, {
      method: "DELETE",
    })).status).toBe(204);

    for (const path of [
      "/api/desktop-ui/heartbeat",
      "/api/desktop-ui/installations/rotate",
      "/api/desktop-ui/notifications",
      "/api/desktop-ui/attendance/upload",
      "/api/desktop-ui/attendance/preferences",
    ]) {
      expect((await uiRequest(store, path, issued.accessToken)).status).toBe(404);
    }
  });
});
