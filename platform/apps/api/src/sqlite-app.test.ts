import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildApp, type BuildAppOptions } from "./app.js";
import {
  SqliteAttendanceSnapshotStore,
  SqliteClaimTransportStore,
  SqliteDesktopIdentityStore,
  SqliteDesktopSessionStore,
  SqlitePairingStore,
  openSqliteDatabase,
  type SqliteDatabase,
} from "./infra/sqlite/index.js";
import { AesGcmSessionSealer } from "./lms/session-vault.js";
import { DEFAULT_DEVICE_SESSION_TTL_MS } from "./domain/pairing.js";

const LOOPBACK_ORIGIN = "http://127.0.0.1:5173";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

describe("SQLite-backed API restart", () => {
  it("keeps exactly one active session after repeated desktop session issue", async () => {
    const database = openSqliteDatabase(":memory:");
    const app = await buildApp(sqliteOptions(database, Buffer.alloc(32, 9)));

    const firstResponse = await app.inject({
      method: "POST",
      url: "/api/dev/desktop-session",
    });
    const firstCookie = cookiePair(firstResponse.headers["set-cookie"]);
    const secondResponse = await app.inject({
      method: "POST",
      url: "/api/dev/desktop-session",
    });
    const secondCookie = cookiePair(secondResponse.headers["set-cookie"]);

    expect(firstResponse.statusCode).toBe(204);
    expect(secondResponse.statusCode).toBe(204);
    expect(secondCookie).not.toBe(firstCookie);
    expect(
      database
        .prepare(`
          SELECT COUNT(*) AS count
          FROM desktop_sessions
          WHERE user_id = 'demo-user'
            AND desktop_device_id = 'demo-desktop'
            AND revoked_at_epoch_ms IS NULL
            AND expires_at_epoch_ms > ?
        `)
        .get(Date.now()),
    ).toEqual({ count: 1 });
    const oldStatus = await app.inject({
      method: "GET",
      url: "/api/private/desktop/status",
      headers: { cookie: firstCookie },
    });
    const newStatus = await app.inject({
      method: "GET",
      url: "/api/private/desktop/status",
      headers: { cookie: secondCookie },
    });
    expect(oldStatus.statusCode).toBe(401);
    expect(newStatus.statusCode).toBe(200);

    await app.close();
    database.close();
  });

  it("preserves cookie auth and replays the same mobile cookie after response loss", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jungle-bell-api-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "platform.sqlite");
    const key = Buffer.alloc(32, 7);

    const firstDatabase = openSqliteDatabase(path);
    const firstApp = await buildApp(sqliteOptions(firstDatabase, key));
    const desktopResponse = await firstApp.inject({
      method: "POST",
      url: "/api/dev/desktop-session",
    });
    expect(desktopResponse.statusCode).toBe(204);
    expect(desktopResponse.body).toBe("");
    const desktopCookie = cookiePair(desktopResponse.headers["set-cookie"]);
    const appSessionToken = cookieValue(desktopCookie);
    const stored = firstDatabase
      .prepare("SELECT token_hash FROM desktop_sessions")
      .get() as { token_hash: string };
    expect(stored.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.token_hash).not.toBe(appSessionToken);

    const pairingResponse = await firstApp.inject({
      method: "POST",
      url: "/api/pairings",
      headers: mutationHeaders(desktopCookie),
    });
    const pairing = pairingResponse.json<{
      pairingId: string;
      qrPayload: string;
    }>();
    const challenge = new URLSearchParams(
      new URL(pairing.qrPayload).hash.slice(1),
    ).get("challenge");
    const claimResponse = await firstApp.inject({
      method: "POST",
      url: `/api/pairings/${pairing.pairingId}/claims`,
      headers: mutationHeaders(),
      payload: {
        challenge,
        deviceLabel: "Restart phone",
        installationId: `jbmi_${"2".repeat(32)}`,
      },
    });
    const claim = claimResponse.json<{
      claimId: string;
      claimReceipt: string;
    }>();
    const approval = await firstApp.inject({
      method: "POST",
      url: `/api/pairings/${pairing.pairingId}/approve`,
      headers: mutationHeaders(desktopCookie),
      payload: { claimId: claim.claimId },
    });
    expect(approval.statusCode).toBe(204);
    await firstApp.close();
    firstDatabase.close();

    const restartedDatabase = openSqliteDatabase(path);
    const restartedApp = await buildApp(sqliteOptions(restartedDatabase, key));
    const status = await restartedApp.inject({
      method: "GET",
      url: `/api/pairings/${pairing.pairingId}`,
      headers: { cookie: desktopCookie },
    });
    expect(status.json()).toMatchObject({ status: "approved" });

    const completion = await restartedApp.inject({
      method: "POST",
      url: `/api/pairings/${pairing.pairingId}/complete`,
      headers: mutationHeaders(),
      payload: {
        claimId: claim.claimId,
        claimReceipt: claim.claimReceipt,
      },
    });
    expect(completion.statusCode).toBe(204);
    expect(completion.body).toBe("");
    const completionCookie = Array.isArray(completion.headers["set-cookie"])
      ? completion.headers["set-cookie"][0]
      : completion.headers["set-cookie"];
    const maxAge = Number(/Max-Age=(\d+)/u.exec(completionCookie ?? "")?.[1]);
    expect(maxAge).toBeGreaterThanOrEqual(
      Math.floor(DEFAULT_DEVICE_SESSION_TTL_MS / 1_000) - 5,
    );
    expect(maxAge).toBeLessThanOrEqual(
      Math.floor(DEFAULT_DEVICE_SESSION_TTL_MS / 1_000),
    );
    expect(
      restartedDatabase
        .prepare(`
          SELECT expires_at_epoch_ms - created_at_epoch_ms AS lifetime_ms
          FROM device_sessions
        `)
        .get(),
    ).toEqual({ lifetime_ms: DEFAULT_DEVICE_SESSION_TTL_MS });
    const mobileCookie = cookiePair(completion.headers["set-cookie"]);
    const dashboard = await restartedApp.inject({
      method: "GET",
      url: "/api/private/dashboard",
      headers: { cookie: mobileCookie },
    });
    expect(dashboard.statusCode).toBe(200);

    const replay = await restartedApp.inject({
      method: "POST",
      url: `/api/pairings/${pairing.pairingId}/complete`,
      headers: mutationHeaders(),
      payload: {
        claimId: claim.claimId,
        claimReceipt: claim.claimReceipt,
      },
    });
    expect(replay.statusCode).toBe(204);
    expect(cookiePair(replay.headers["set-cookie"])).toBe(mobileCookie);

    await restartedApp.close();
    restartedDatabase.close();
  });
});

function sqliteOptions(
  database: SqliteDatabase,
  key: Uint8Array,
): BuildAppOptions {
  const pairingStore = new SqlitePairingStore(database);
  return {
    allowDevBootstrap: true,
    attendanceSnapshotStore:
      new SqliteAttendanceSnapshotStore(database),
    desktopIdentityStore: new SqliteDesktopIdentityStore(database),
    pairingStore,
    pairingApprovalTransportStore: pairingStore,
    desktopSessionStore: new SqliteDesktopSessionStore(database),
    claimTransportStore: new SqliteClaimTransportStore(database),
    tokenSealer: new AesGcmSessionSealer(key),
  };
}

function cookiePair(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  expect(value).toEqual(expect.any(String));
  return value!.split(";", 1)[0]!;
}

function cookieValue(cookie: string): string {
  return cookie.slice(cookie.indexOf("=") + 1);
}

function mutationHeaders(cookie?: string) {
  return {
    origin: LOOPBACK_ORIGIN,
    ...(cookie === undefined ? {} : { cookie }),
  };
}
