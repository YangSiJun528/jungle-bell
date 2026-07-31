import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  LATEST_SQLITE_SCHEMA_VERSION,
  SqliteAttendanceSnapshotStore,
  SqliteDesktopIdentityStore,
  SqliteDesktopSessionStore,
  SqlitePairingStore,
  openSqliteDatabase,
} from "./index.js";
import { SqliteCampusUserRepository } from "../../campus/repository.js";
import { SqliteNotificationRepository } from "../../notifications/repository.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

async function temporaryDatabasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "jungle-bell-sqlite-"));
  temporaryDirectories.push(directory);
  return join(directory, "platform.sqlite");
}

describe("SQLite platform schema", () => {
  it("uses WAL safety settings and contains no server-side LMS credential table", async () => {
    const path = await temporaryDatabasePath();
    const database = openSqliteDatabase(path);

    expect(database.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(database.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(database.pragma("synchronous", { simple: true })).toBe(2);
    expect(database.pragma("busy_timeout", { simple: true })).toBe(5_000);
    expect(database.pragma("user_version", { simple: true })).toBe(
      LATEST_SQLITE_SCHEMA_VERSION,
    );
    const tables = database
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name",
      )
      .all()
      .map(({ name }) => name);
    expect(tables).toContain("users");
    expect(tables).toContain("external_identities");
    expect(tables).toContain("desktop_devices");
    expect(tables).toContain("attendance_snapshots");
    expect(tables).not.toContain("lms_sessions");
    expect(tables).not.toContain("attendance_collector_runs");

    const credentialLikeColumns = database
      .prepare<[], { table_name: string; column_name: string }>(`
        SELECT
          sqlite_schema.name AS table_name,
          pragma_table_info.name AS column_name
        FROM sqlite_schema
        JOIN pragma_table_info(sqlite_schema.name)
        WHERE sqlite_schema.type = 'table'
          AND (
            lower(pragma_table_info.name) LIKE '%cookie%'
            OR lower(pragma_table_info.name) LIKE '%refresh_token%'
            OR lower(pragma_table_info.name) LIKE '%access_token%'
          )
      `)
      .all();
    expect(credentialLikeColumns).toEqual([]);
    expect(database.pragma("foreign_key_check")).toEqual([]);
    database.close();
  });

  it("refuses an old schema instead of retaining a stage-0 LMS credential table", async () => {
    const path = await temporaryDatabasePath();
    const old = new Database(path);
    old.exec(`
      CREATE TABLE lms_sessions (
        user_id TEXT PRIMARY KEY,
        ciphertext_base64 TEXT NOT NULL
      );
      PRAGMA user_version = 1;
    `);
    old.close();

    expect(() => openSqliteDatabase(path)).toThrow(
      "SQLITE_SCHEMA_RESET_REQUIRED",
    );
  });

  it("upgrades a v1 pairing schema, preserves server data, and cancels orphan Push delivery", async () => {
    const path = await temporaryDatabasePath();
    const database = openSqliteDatabase(path);
    const identities = new SqliteDesktopIdentityStore(database);
    const identity = await identities.registerVerifiedIdentity({
      candidateUserId: "user-v1",
      desktopDeviceId: "desktop-v1",
      subjectHmac: "b".repeat(64),
      verifiedAtEpochMs: 1_000,
    });
    await new SqliteAttendanceSnapshotStore(database).putNewest({
      userId: identity.userId,
      sourceDeviceId: identity.desktopDeviceId,
      attendanceDate: "2026-07-31",
      cohortId: null,
      cohortStatus: "unknown",
      cohortStartDate: null,
      cohortEndDate: null,
      morningChecked: false,
      eveningChecked: false,
      collectedAtEpochMs: 1_000,
      receivedAtEpochMs: 1_000,
    });
    new SqliteCampusUserRepository(database).upsertMealRule({
      userId: identity.userId,
      enabled: true,
      breakfast: false,
      lunch: true,
      dinner: false,
      updatedAtEpochMs: 1_000,
    });
    const notifications = new SqliteNotificationRepository(database);
    const notification = notifications.enqueueIntent(
      {
        userId: identity.userId,
        kind: "meal-published",
        sourceEventId: "v1-meal",
        dedupeKey: "v1_meal",
        content: {
          title: "중식",
          body: "메뉴",
          path: "/app#meals",
        },
        metadata: {},
        targetDeviceId: null,
        occurredAtEpochMs: 1_000,
        expiresAtEpochMs: 10_000,
      },
      1_000,
    );
    const [claimed] = notifications.claimOutbox(1_000, 10, 100);
    notifications.createDeliveries(
      claimed!.event,
      [
        {
          userId: identity.userId,
          deviceId: "legacy-mobile",
          channel: "web-push",
          destinationId: "legacy-push",
          enabled: true,
        },
      ],
      1_000,
    );
    notifications.completeOutbox(notification.eventId, 1_000);

    database.exec(`
      DROP TABLE notification_preferences;
      DROP TABLE push_subscriptions;
      DROP TABLE pairing_claim_transports;
      DROP TABLE device_sessions;
      DROP TABLE pairing_challenges;
      CREATE TABLE pairing_challenges (
        challenge_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        desktop_device_id TEXT NOT NULL,
        pairing_code_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        claimed_public_key TEXT,
        claimed_device_label TEXT,
        created_at_epoch_ms INTEGER NOT NULL,
        expires_at_epoch_ms INTEGER NOT NULL,
        approved_at_epoch_ms INTEGER,
        version INTEGER NOT NULL
      );
      CREATE TABLE device_sessions (
        session_id TEXT PRIMARY KEY,
        pairing_challenge_id TEXT,
        user_id TEXT,
        device_id TEXT,
        device_label TEXT,
        public_key TEXT,
        token_hash TEXT,
        scopes_json TEXT,
        created_at_epoch_ms INTEGER,
        revoked_at_epoch_ms INTEGER,
        version INTEGER
      );
      CREATE TABLE notification_preferences (
        user_id TEXT,
        device_id TEXT
      );
      CREATE TABLE pairing_claim_transports (
        claim_id TEXT,
        challenge_id TEXT
      );
      CREATE TABLE push_subscriptions (
        id TEXT,
        user_id TEXT,
        device_id TEXT
      );
      INSERT INTO pairing_challenges VALUES (
        'legacy-challenge', 'user-v1', 'desktop-v1', 'pair-hash',
        'approved', 'unused-public-key', 'Old phone',
        1, 10, 2, 2
      );
      INSERT INTO device_sessions VALUES (
        'legacy-session', 'legacy-challenge', 'user-v1',
        'legacy-mobile', 'Old phone', 'unused-public-key',
        'legacy-token-hash', '[]', 2, NULL, 0
      );
      INSERT INTO push_subscriptions VALUES (
        'legacy-push', 'user-v1', 'legacy-mobile'
      );
      PRAGMA user_version = 1;
    `);
    database.close();

    const upgraded = openSqliteDatabase(path);
    expect(upgraded.pragma("user_version", { simple: true })).toBe(
      LATEST_SQLITE_SCHEMA_VERSION,
    );
    expect(upgraded.pragma("integrity_check", { simple: true })).toBe("ok");
    expect(upgraded.pragma("foreign_key_check")).toEqual([]);
    expect(
      upgraded
        .prepare("SELECT COUNT(*) AS count FROM users WHERE id = 'user-v1'")
        .get(),
    ).toEqual({ count: 1 });
    expect(
      await new SqliteAttendanceSnapshotStore(upgraded).getLatest(
        "user-v1",
      ),
    ).not.toBeNull();
    expect(
      new SqliteCampusUserRepository(upgraded).getMealRule("user-v1"),
    ).toMatchObject({ enabled: true, lunch: true });
    expect(
      upgraded
        .prepare(
          "SELECT status, last_error_code FROM notification_deliveries",
        )
        .get(),
    ).toEqual({
      status: "cancelled",
      last_error_code: "PAIRING_SCHEMA_UPGRADE",
    });
    const pairingStore = new SqlitePairingStore(upgraded);
    expect(
      await pairingStore.insertChallenge({
        challengeId: "new-challenge",
        userId: "user-v1",
        desktopDeviceId: "desktop-v1",
        pairingCodeHash: "new-pair-hash",
        manualCodeHash: "new-manual-hash",
        status: "pending",
        claimedDeviceLabel: null,
        claimedInstallationId: null,
        createdAtEpochMs: 2_000,
        expiresAtEpochMs: 3_000,
        approvedAtEpochMs: null,
        version: 0,
      }),
    ).toBe(true);
    upgraded.close();
  });

  it("finds one internal UUID-equivalent user for one HMAC across independent PCs and restarts", async () => {
    const path = await temporaryDatabasePath();
    const subjectHmac = "a".repeat(64);
    const firstDatabase = openSqliteDatabase(path);
    const firstStore = new SqliteDesktopIdentityStore(firstDatabase);

    const first = await firstStore.registerVerifiedIdentity({
      candidateUserId: `jbu_${"1".repeat(64)}`,
      desktopDeviceId: "desktop-installation-a",
      subjectHmac,
      verifiedAtEpochMs: 1_000,
    });
    expect(first).toMatchObject({
      createdUser: true,
      desktopDeviceId: "desktop-installation-a",
    });
    firstDatabase.close();

    const secondDatabase = openSqliteDatabase(path);
    const secondStore = new SqliteDesktopIdentityStore(secondDatabase);
    const second = await secondStore.registerVerifiedIdentity({
      candidateUserId: `jbu_${"2".repeat(64)}`,
      desktopDeviceId: "desktop-installation-b",
      subjectHmac,
      verifiedAtEpochMs: 2_000,
    });
    expect(second).toEqual({
      userId: first.userId,
      desktopDeviceId: "desktop-installation-b",
      createdUser: false,
    });
    expect(await secondStore.listDesktopDevices(first.userId)).toHaveLength(2);

    const identityRow = secondDatabase
      .prepare(
        `SELECT provider, subject_hmac, user_id
         FROM external_identities`,
      )
      .get();
    expect(identityRow).toEqual({
      provider: "jungle_lms",
      subject_hmac: subjectHmac,
      user_id: first.userId,
    });
    secondDatabase.close();
  });

  it("atomically couples a login-required heartbeat to its durable outbox event", async () => {
    const database = openSqliteDatabase(":memory:");
    const identities = new SqliteDesktopIdentityStore(database);
    const notifications = new SqliteNotificationRepository(database);
    const identity = await identities.registerVerifiedIdentity({
      candidateUserId: `jbu_${"7".repeat(64)}`,
      desktopDeviceId: "desktop-installation-a",
      subjectHmac: "d".repeat(64),
      verifiedAtEpochMs: 1_000,
    });
    const intent = {
      userId: identity.userId,
      kind: "login-required" as const,
      sourceEventId: "login-required:desktop-installation-a:2000",
      dedupeKey: "login_required_desktop_installation_a_2000",
      content: {
        title: "LMS 로그인이 필요합니다",
        body: "PC에서 LMS에 다시 로그인해 주세요.",
        path: "/app#attendance",
      },
      metadata: {
        reason: "expired",
        desktopDeviceId: identity.desktopDeviceId,
      },
      targetDeviceId: null,
      occurredAtEpochMs: 2_000,
      expiresAtEpochMs: 86_402_000,
    };
    const heartbeat = {
      userId: identity.userId,
      desktopDeviceId: identity.desktopDeviceId,
      receivedAtEpochMs: 2_000,
      lmsSessionState: "login-required" as const,
      appVersion: "0.2.0",
    };

    await expect(
      identities.recordHeartbeat(heartbeat, () => {
        notifications.enqueueIntent(intent, 2_000);
        throw new Error("simulated durable storage failure");
      }),
    ).rejects.toThrow("simulated durable storage failure");
    expect(
      await identities.getDesktopDevice(
        identity.userId,
        identity.desktopDeviceId,
      ),
    ).toMatchObject({ lmsSessionState: "connected" });
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM notification_events")
        .get(),
    ).toEqual({ count: 0 });
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM notification_outbox")
        .get(),
    ).toEqual({ count: 0 });

    await expect(
      identities.recordHeartbeat(
        { ...heartbeat, receivedAtEpochMs: 2_100 },
        () => {
          expect(
            notifications.enqueueIntent(intent, 2_100).inserted,
          ).toBe(true);
        },
      ),
    ).resolves.toMatchObject({ lmsSessionState: "login-required" });
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM notification_events")
        .get(),
    ).toEqual({ count: 1 });
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM notification_outbox")
        .get(),
    ).toEqual({ count: 1 });

    let duplicateTransitions = 0;
    await identities.recordHeartbeat(
      { ...heartbeat, receivedAtEpochMs: 2_200 },
      () => {
        duplicateTransitions += 1;
      },
    );
    expect(duplicateTransitions).toBe(0);
    expect(database.pragma("foreign_key_check")).toEqual([]);
    database.close();
  });

  it("atomically rotates one active desktop session without touching another device", async () => {
    const database = openSqliteDatabase(":memory:");
    const identities = new SqliteDesktopIdentityStore(database);
    const sessions = new SqliteDesktopSessionStore(database);
    const firstDevice = await identities.registerVerifiedIdentity({
      candidateUserId: `jbu_${"4".repeat(64)}`,
      desktopDeviceId: "desktop-installation-a",
      subjectHmac: "c".repeat(64),
      verifiedAtEpochMs: 1_000,
    });
    const secondDevice = await identities.registerVerifiedIdentity({
      candidateUserId: `jbu_${"5".repeat(64)}`,
      desktopDeviceId: "desktop-installation-b",
      subjectHmac: "c".repeat(64),
      verifiedAtEpochMs: 1_000,
    });
    const firstSession = {
      tokenHash: "first-token-hash",
      userId: firstDevice.userId,
      desktopDeviceId: firstDevice.desktopDeviceId,
      createdAtEpochMs: 1_000,
      expiresAtEpochMs: 10_000,
      revokedAtEpochMs: null,
      version: 0,
    };
    const otherDeviceSession = {
      ...firstSession,
      tokenHash: "other-device-token-hash",
      desktopDeviceId: secondDevice.desktopDeviceId,
    };
    expect(await sessions.insertReplacingActive(firstSession)).toBe(true);
    expect(
      await sessions.insertReplacingActive(otherDeviceSession),
    ).toBe(true);

    const replacement = {
      ...firstSession,
      tokenHash: "replacement-token-hash",
      createdAtEpochMs: 2_000,
      expiresAtEpochMs: 11_000,
    };
    expect(await sessions.insertReplacingActive(replacement)).toBe(true);
    expect(await sessions.findByTokenHash(firstSession.tokenHash))
      .toMatchObject({
        revokedAtEpochMs: 2_000,
        version: 1,
      });
    expect(await sessions.findByTokenHash(replacement.tokenHash))
      .toMatchObject({
        revokedAtEpochMs: null,
        version: 0,
      });
    expect(
      await sessions.findByTokenHash(otherDeviceSession.tokenHash),
    ).toMatchObject({
      revokedAtEpochMs: null,
      version: 0,
    });
    expect(
      database
        .prepare(`
          SELECT COUNT(*) AS count
          FROM desktop_sessions
          WHERE user_id = ?
            AND desktop_device_id = ?
            AND revoked_at_epoch_ms IS NULL
            AND expires_at_epoch_ms > ?
        `)
        .get(firstDevice.userId, firstDevice.desktopDeviceId, 2_000),
    ).toEqual({ count: 1 });

    const collision = {
      ...replacement,
      tokenHash: otherDeviceSession.tokenHash,
      createdAtEpochMs: 3_000,
      expiresAtEpochMs: 12_000,
    };
    expect(await sessions.insertReplacingActive(collision)).toBe(false);
    expect(await sessions.findByTokenHash(replacement.tokenHash))
      .toMatchObject({
        revokedAtEpochMs: null,
        version: 0,
      });
    expect(
      database
        .prepare(`
          SELECT COUNT(*) AS count
          FROM desktop_sessions
          WHERE user_id = ?
            AND desktop_device_id = ?
            AND revoked_at_epoch_ms IS NULL
            AND expires_at_epoch_ms > ?
        `)
        .get(firstDevice.userId, firstDevice.desktopDeviceId, 3_000),
    ).toEqual({ count: 1 });
    expect(database.pragma("foreign_key_check")).toEqual([]);
    database.close();
  });

  it("atomically stores only a strictly newer attendance snapshot and records its source PC", async () => {
    const database = openSqliteDatabase(":memory:");
    const identities = new SqliteDesktopIdentityStore(database);
    const attendance = new SqliteAttendanceSnapshotStore(database);
    const identity = await identities.registerVerifiedIdentity({
      candidateUserId: `jbu_${"3".repeat(64)}`,
      desktopDeviceId: "desktop-installation-a",
      subjectHmac: "b".repeat(64),
      verifiedAtEpochMs: 1_000,
    });

    const base = {
      userId: identity.userId,
      sourceDeviceId: identity.desktopDeviceId,
      attendanceDate: "2026-07-31",
      cohortId: "cohort-7",
      cohortStatus: "active" as const,
      cohortStartDate: "2026-07-01",
      cohortEndDate: "2026-08-01",
      morningChecked: true,
      eveningChecked: false,
      collectedAtEpochMs: 3_000,
      receivedAtEpochMs: 3_100,
    };
    await expect(attendance.putNewest(base)).resolves.toMatchObject({
      accepted: true,
      snapshot: { version: 0 },
    });
    await expect(
      attendance.putNewest({
        ...base,
        morningChecked: false,
        collectedAtEpochMs: 2_000,
        receivedAtEpochMs: 3_200,
      }),
    ).resolves.toMatchObject({
      accepted: false,
      snapshot: { morningChecked: true, version: 0 },
    });
    await expect(
      attendance.putNewest({
        ...base,
        eveningChecked: true,
        collectedAtEpochMs: 4_000,
        receivedAtEpochMs: 4_100,
      }),
    ).resolves.toMatchObject({
      accepted: true,
      snapshot: {
        sourceDeviceId: "desktop-installation-a",
        eveningChecked: true,
        version: 1,
      },
    });
    expect(database.pragma("foreign_key_check")).toEqual([]);
    database.close();
  });
});
