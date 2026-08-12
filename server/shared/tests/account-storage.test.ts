import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { D1RenewalStore } from "../persistence/d1-renewal-store";
import type { AppSessionRecord } from "../ports/account-storage";
import type { SqlDatabase, SqlPreparedStatement, SqlResult, SqlValue } from "../ports/sql-database";
import { planLaundryTransition } from "../domain/laundry-notifications";
import {
  DESKTOP_ENROLLMENT_POLICY,
  MANUAL_PAIRING_CLAIM_POLICY,
  PAIRING_CREATION_POLICY,
  PAIRING_TTL_MS,
} from "../domain/enrollment-policy";

interface BoundStatement {
  sql: string;
  values: SQLInputValue[];
}

function sqliteValues(values: readonly SqlValue[]): SQLInputValue[] {
  return values.map((value) => typeof value === "boolean" ? (value ? 1 : 0) : value);
}

function sqliteD1(database: DatabaseSync, onBatch?: (statementCount: number) => void): SqlDatabase {
  return {
    prepare(sql: string) {
      return {
        bind(...values: SqlValue[]) {
          const boundValues = sqliteValues(values);
          return {
            sql,
            values: boundValues,
            async first<T>() {
              return (database.prepare(sql).get(...boundValues) as T | undefined) ?? null;
            },
            async all<T>() {
              return { results: database.prepare(sql).all(...boundValues) as T[] };
            },
            async run() {
              const result = database.prepare(sql).run(...boundValues);
              return { meta: { changes: Number(result.changes) } };
            },
          } as unknown as SqlPreparedStatement;
        },
      } as unknown as SqlPreparedStatement;
    },
    async batch(statements: SqlPreparedStatement[]) {
      onBatch?.(statements.length);
      database.exec("BEGIN IMMEDIATE");
      try {
        const results = statements.map((raw) => {
          const statement = raw as unknown as BoundStatement;
          if (/^\s*(?:SELECT\b|WITH\s+target\b)/iu.test(statement.sql)) {
            return {
              success: true,
              results: database.prepare(statement.sql).all(...statement.values),
              meta: { changes: 0 },
            } as unknown as SqlResult;
          }
          const result = database.prepare(statement.sql).run(...statement.values);
          return { success: true, results: [], meta: { changes: Number(result.changes) } } as unknown as SqlResult;
        });
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as SqlDatabase;
}

function mobileSession(id: string, nowEpochMs: number): AppSessionRecord {
  return {
    id,
    userId: "user-1",
    installationId: "mobile-1",
    kind: "mobile",
    label: "내 휴대폰",
    tokenSha256: "c".repeat(64),
    createdAtEpochMs: nowEpochMs,
    expiresAtEpochMs: nowEpochMs + 365 * 24 * 60 * 60_000,
    lastSeenAtEpochMs: nowEpochMs,
    revokedAtEpochMs: null,
    sourcePairingId: "pairing-1",
  };
}

describe("desktop UI session D1 migration and persistence", () => {
  it("is non-destructive, upserts per parent, binds origin and preserves only a token hash", async () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE app_user (id TEXT PRIMARY KEY, created_at_epoch_ms INTEGER NOT NULL);
        CREATE TABLE desktop_device (
          installation_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at_epoch_ms INTEGER NOT NULL,
          last_seen_at_epoch_ms INTEGER, lms_session_state TEXT NOT NULL, app_version TEXT
        );
        CREATE TABLE app_session (
          id TEXT PRIMARY KEY, user_id TEXT NOT NULL, installation_id TEXT NOT NULL, kind TEXT NOT NULL,
          label TEXT, token_sha256 TEXT NOT NULL UNIQUE, created_at_epoch_ms INTEGER NOT NULL,
          expires_at_epoch_ms INTEGER NOT NULL, last_seen_at_epoch_ms INTEGER NOT NULL,
          revoked_at_epoch_ms INTEGER, source_pairing_id TEXT UNIQUE
        );
        INSERT INTO app_user VALUES ('user-1', 1);
        INSERT INTO desktop_device VALUES ('desktop-1', 'user-1', 1, 1, 'connected', NULL);
        INSERT INTO app_session VALUES (
          'parent-1', 'user-1', 'desktop-1', 'desktop', NULL, '${"1".repeat(64)}', 1, 1000, 1, NULL, NULL
        );
      `);
      const migration = readFileSync(
        new URL("../../database/migrations/2026-08-12-desktop-ui-sessions.sql", import.meta.url),
        "utf8",
      );
      expect(migration).not.toMatch(/^\s*(?:DROP|DELETE|UPDATE|ALTER)\b/imu);
      database.exec(migration);
      expect(database.prepare("SELECT id FROM app_user").all()).toEqual([{ id: "user-1" }]);

      const store = new D1RenewalStore(sqliteD1(database));
      const base = {
        parentSessionId: "parent-1", userId: "user-1", installationId: "desktop-1",
        origin: "tauri://localhost", scope: "desktop-ui-v1",
        createdAtEpochMs: 10, expiresAtEpochMs: 430_000,
      };
      expect(await store.replaceDesktopUiSession({
        ...base, id: "ui-1", tokenSha256: "2".repeat(64),
      })).toBe(true);
      expect(await store.replaceDesktopUiSession({
        ...base, id: "ui-2", tokenSha256: "3".repeat(64), createdAtEpochMs: 11, expiresAtEpochMs: 430_001,
      })).toBe(true);
      await expect(store.findDesktopUiSessionByTokenHash("2".repeat(64))).resolves.toBeNull();
      await expect(store.findDesktopUiSessionByTokenHash("3".repeat(64))).resolves.toMatchObject({
        id: "ui-2", parentSessionId: "parent-1", origin: "tauri://localhost", scope: "desktop-ui-v1",
      });
      await expect(store.deleteDesktopUiSession({
        parentSessionId: "parent-1", userId: "user-1", installationId: "desktop-1",
        origin: "http://tauri.localhost",
      })).resolves.toBe(false);
      await expect(store.deleteDesktopUiSession({
        parentSessionId: "parent-1", userId: "user-1", installationId: "desktop-1",
        origin: "tauri://localhost",
      })).resolves.toBe(true);
    } finally {
      database.close();
    }
  });
});

describe("D1RenewalStore pairing approval", () => {
  it("does not revoke the winning session or subscription when a racing approval loses", async () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(`
        CREATE TABLE pairing_challenge (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          desktop_installation_id TEXT NOT NULL,
          claim_receipt_sha256 TEXT,
          status TEXT NOT NULL,
          mobile_installation_id TEXT,
          mobile_label TEXT,
          expires_at_epoch_ms INTEGER NOT NULL,
          approved_at_epoch_ms INTEGER
        );
        CREATE TABLE app_session (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          installation_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          label TEXT,
          token_sha256 TEXT NOT NULL UNIQUE,
          created_at_epoch_ms INTEGER NOT NULL,
          expires_at_epoch_ms INTEGER NOT NULL,
          last_seen_at_epoch_ms INTEGER NOT NULL,
          revoked_at_epoch_ms INTEGER,
          source_pairing_id TEXT UNIQUE
        );
        CREATE TABLE push_subscription (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          endpoint TEXT NOT NULL,
          p256dh TEXT NOT NULL,
          auth TEXT NOT NULL,
          created_at_epoch_ms INTEGER NOT NULL,
          revoked_at_epoch_ms INTEGER
        );
        CREATE TABLE notification_delivery (
          notification_id TEXT NOT NULL,
          target_kind TEXT NOT NULL,
          target_id TEXT NOT NULL,
          status TEXT NOT NULL,
          attempts INTEGER NOT NULL,
          next_attempt_at_epoch_ms INTEGER,
          last_error TEXT,
          delivered_at_epoch_ms INTEGER,
          lease_token TEXT,
          lease_expires_at_epoch_ms INTEGER,
          PRIMARY KEY (notification_id, target_kind, target_id)
        );
      `);
      const now = Date.parse("2026-08-03T00:00:00.000Z");
      database.prepare(`INSERT INTO pairing_challenge (id, user_id, desktop_installation_id, claim_receipt_sha256,
        status, mobile_installation_id, mobile_label, expires_at_epoch_ms, approved_at_epoch_ms)
        VALUES (?, ?, ?, ?, 'claimed', ?, ?, ?, NULL)`)
        .run("pairing-1", "user-1", "desktop-1", "a".repeat(64), "mobile-1", "내 휴대폰", now + 60_000);
      database.prepare(`INSERT INTO app_session (id, user_id, installation_id, kind, label, token_sha256,
        created_at_epoch_ms, expires_at_epoch_ms, last_seen_at_epoch_ms, revoked_at_epoch_ms, source_pairing_id)
        VALUES (?, ?, ?, 'mobile', ?, ?, ?, ?, ?, NULL, NULL)`)
        .run("old-session", "user-1", "mobile-1", "이전 세션", "b".repeat(64), now - 10_000, now + 50_000, now - 10_000);
      database.prepare(`INSERT INTO push_subscription (id, user_id, session_id, endpoint, p256dh, auth,
        created_at_epoch_ms, revoked_at_epoch_ms) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`)
        .run("old-push", "user-1", "old-session", "https://push.example/old", "key", "auth", now - 10_000);
      database.prepare(`INSERT INTO notification_delivery (notification_id, target_kind, target_id, status,
        attempts, next_attempt_at_epoch_ms, last_error, delivered_at_epoch_ms)
        VALUES ('pending-old', 'push', 'old-push', 'pending', 0, ?, NULL, NULL)`).run(now);

      const store = new D1RenewalStore(sqliteD1(database));
      const winner = mobileSession("winning-session", now);
      expect(await store.approvePairing("pairing-1", "desktop-1", winner, now)).toBe(true);
      expect(database.prepare("SELECT revoked_at_epoch_ms FROM app_session WHERE id = ?").get("old-session"))
        .toEqual({ revoked_at_epoch_ms: now });
      expect(database.prepare("SELECT revoked_at_epoch_ms FROM push_subscription WHERE id = ?").get("old-push"))
        .toEqual({ revoked_at_epoch_ms: now });
      expect(database.prepare(`SELECT status, last_error FROM notification_delivery
        WHERE notification_id = 'pending-old'`).get()).toEqual({
        status: "failed", last_error: "MOBILE_SESSION_REPLACED",
      });

      database.prepare(`INSERT INTO push_subscription (id, user_id, session_id, endpoint, p256dh, auth,
        created_at_epoch_ms, revoked_at_epoch_ms) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`)
        .run("winning-push", "user-1", winner.id, "https://push.example/winner", "key", "auth", now);
      const loser = mobileSession("losing-session", now + 1);

      expect(await store.approvePairing("pairing-1", "desktop-1", loser, now + 1)).toBe(false);
      expect(database.prepare("SELECT revoked_at_epoch_ms FROM app_session WHERE id = ?").get(winner.id))
        .toEqual({ revoked_at_epoch_ms: null });
      expect(database.prepare("SELECT revoked_at_epoch_ms FROM push_subscription WHERE id = ?").get("winning-push"))
        .toEqual({ revoked_at_epoch_ms: null });
      expect(database.prepare("SELECT id FROM app_session WHERE id = ?").get(loser.id)).toBeUndefined();
    } finally {
      database.close();
    }
  });
});

describe("attendance preference D1 migration", () => {
  it("preserves existing rows and applies legacy-compatible schedule defaults", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(`CREATE TABLE attendance_preference (
        user_id TEXT PRIMARY KEY,
        morning_enabled INTEGER NOT NULL,
        evening_enabled INTEGER NOT NULL,
        skip_sunday INTEGER NOT NULL DEFAULT 0,
        skip_attendance_date TEXT,
        updated_at_epoch_ms INTEGER NOT NULL
      );
      INSERT INTO attendance_preference
        (user_id, morning_enabled, evening_enabled, skip_sunday, skip_attendance_date, updated_at_epoch_ms)
      VALUES ('user-existing', 0, 1, 1, '2026-08-03', 1234);`);

      const migration = readFileSync(
        new URL("../../database/migrations/2026-08-12-attendance-notification-preferences.sql", import.meta.url),
        "utf8",
      );
      expect(migration).not.toMatch(/\b(?:DROP|DELETE|UPDATE)\b/iu);
      database.exec(migration);

      expect(database.prepare("SELECT * FROM attendance_preference WHERE user_id = ?").get("user-existing"))
        .toEqual({
          user_id: "user-existing",
          morning_enabled: 0,
          evening_enabled: 1,
          skip_sunday: 1,
          skip_attendance_date: "2026-08-03",
          updated_at_epoch_ms: 1234,
          enabled: 1,
          morning_start_hour: 9,
          evening_end_hour: 4,
          morning_interval_minutes: 15,
          evening_interval_minutes: 15,
        });
      database.prepare(`INSERT INTO attendance_preference
        (user_id, morning_enabled, evening_enabled, skip_sunday, skip_attendance_date, updated_at_epoch_ms)
        VALUES ('user-created-by-old-server', 1, 0, 0, NULL, 5678)`).run();
      expect(database.prepare(`SELECT enabled, morning_start_hour, evening_end_hour,
        morning_interval_minutes, evening_interval_minutes FROM attendance_preference WHERE user_id = ?`)
        .get("user-created-by-old-server")).toEqual({
          enabled: 1,
          morning_start_hour: 9,
          evening_end_hour: 4,
          morning_interval_minutes: 15,
          evening_interval_minutes: 15,
        });
    } finally {
      database.close();
    }
  });
});

describe("D1RenewalStore pairing creation", () => {
  it("persists bounded manual-claim and pairing-creation windows", async () => {
    const database = new DatabaseSync(":memory:");
    try {
        database.exec(readFileSync(new URL("../../database/schema.sql", import.meta.url), "utf8"));
      const store = new D1RenewalStore(sqliteD1(database));
      const now = Date.parse("2026-08-03T00:00:00.000Z");

      for (let index = 0; index < MANUAL_PAIRING_CLAIM_POLICY.installationAttemptLimit; index += 1) {
        await expect(store.consumeManualPairingAttempt(
          "manual-installation-key", now, MANUAL_PAIRING_CLAIM_POLICY.windowMs,
          MANUAL_PAIRING_CLAIM_POLICY.installationAttemptLimit,
        )).resolves.toBe(true);
      }
      await expect(store.consumeManualPairingAttempt(
        "manual-installation-key", now, MANUAL_PAIRING_CLAIM_POLICY.windowMs,
        MANUAL_PAIRING_CLAIM_POLICY.installationAttemptLimit,
      )).resolves.toBe(false);

      for (let index = 0; index < PAIRING_CREATION_POLICY.installationAttemptLimit; index += 1) {
        await expect(store.consumePairingCreationAttempt(
          "desktop-installation-key", now, PAIRING_CREATION_POLICY.windowMs,
          PAIRING_CREATION_POLICY.installationAttemptLimit,
        )).resolves.toBe(true);
      }
      await expect(store.consumePairingCreationAttempt(
        "desktop-installation-key", now, PAIRING_CREATION_POLICY.windowMs,
        PAIRING_CREATION_POLICY.installationAttemptLimit,
      )).resolves.toBe(false);
      expect(database.prepare("SELECT attempt_count FROM pairing_claim_attempt").get()).toEqual({
        attempt_count: MANUAL_PAIRING_CLAIM_POLICY.installationAttemptLimit,
      });
      expect(database.prepare("SELECT attempt_count FROM pairing_creation_attempt").get()).toEqual({
        attempt_count: PAIRING_CREATION_POLICY.installationAttemptLimit,
      });
    } finally {
      database.close();
    }
  });

  it("atomically keeps one unexpired pending or claimed pairing per desktop", async () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(readFileSync(new URL("../../database/schema.sql", import.meta.url), "utf8"));
      const store = new D1RenewalStore(sqliteD1(database));
      const now = Date.parse("2026-08-03T00:00:00.000Z");
      expect(await store.enrollDesktop({
        candidateUserId: "user-1", installationId: "desktop-1", sessionId: "desktop-session",
        tokenSha256: "1".repeat(64), nowEpochMs: now, expiresAtEpochMs: now + 60_000,
      })).toBe(true);
      const pairing = (id: string, createdAtEpochMs: number) => ({
        id, userId: "user-1", desktopInstallationId: "desktop-1",
        pairingSecretSha256: id.endsWith("1") ? "2".repeat(64) : "4".repeat(64),
        manualCodeHash: id.endsWith("1") ? "3".repeat(64) : "5".repeat(64),
        claimReceiptSha256: null, status: "pending" as const, mobileInstallationId: null,
        mobileLabel: null, createdAtEpochMs, expiresAtEpochMs: createdAtEpochMs + PAIRING_TTL_MS,
        approvedAtEpochMs: null,
      });

      await expect(Promise.all([
        store.createPairing(pairing("jbp_00000000-0000-4000-8000-000000000001", now)),
        store.createPairing(pairing("jbp_00000000-0000-4000-8000-000000000002", now)),
      ])).resolves.toEqual([true, false]);
      expect(database.prepare("SELECT id FROM pairing_challenge").all()).toEqual([
        { id: "jbp_00000000-0000-4000-8000-000000000001" },
      ]);

      const afterExpiry = now + PAIRING_TTL_MS + 1;
      await expect(store.createPairing(pairing(
        "jbp_00000000-0000-4000-8000-000000000002",
        afterExpiry,
      ))).resolves.toBe(true);
      expect(database.prepare("SELECT id FROM pairing_challenge ORDER BY id").all()).toHaveLength(2);
    } finally {
      database.close();
    }
  });
});

describe("D1RenewalStore desktop enrollment", () => {
  it("persists the caller's fixed-window enrollment limit and resets it at the boundary", async () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(readFileSync(new URL("../../database/schema.sql", import.meta.url), "utf8"));
      const store = new D1RenewalStore(sqliteD1(database));
      const now = Date.parse("2026-08-03T00:00:00.000Z");

      for (let index = 0; index < DESKTOP_ENROLLMENT_POLICY.installationAttemptLimit; index += 1) {
        await expect(store.consumeDesktopEnrollmentAttempt(
          "installation-rate-key",
          now,
          DESKTOP_ENROLLMENT_POLICY.windowMs,
          DESKTOP_ENROLLMENT_POLICY.installationAttemptLimit,
        )).resolves.toBe(true);
      }
      await expect(store.consumeDesktopEnrollmentAttempt(
        "installation-rate-key",
        now,
        DESKTOP_ENROLLMENT_POLICY.windowMs,
        DESKTOP_ENROLLMENT_POLICY.installationAttemptLimit,
      )).resolves.toBe(false);
      expect(database.prepare(`SELECT attempt_count FROM desktop_enrollment_attempt
        WHERE rate_key = 'installation-rate-key'`).get()).toEqual({
        attempt_count: DESKTOP_ENROLLMENT_POLICY.installationAttemptLimit,
      });
      await expect(store.consumeDesktopEnrollmentAttempt(
        "installation-rate-key",
        now + DESKTOP_ENROLLMENT_POLICY.windowMs,
        DESKTOP_ENROLLMENT_POLICY.windowMs,
        DESKTOP_ENROLLMENT_POLICY.installationAttemptLimit,
      )).resolves.toBe(true);
      expect(database.prepare(`SELECT attempt_count FROM desktop_enrollment_attempt
        WHERE rate_key = 'installation-rate-key'`).get()).toEqual({ attempt_count: 1 });
    } finally {
      database.close();
    }
  });

  it("enrolls a fresh installation exactly once without an LMS identity", async () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(`
        CREATE TABLE app_user (
          id TEXT PRIMARY KEY,
          created_at_epoch_ms INTEGER NOT NULL
        );
        CREATE TABLE desktop_device (
          installation_id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          created_at_epoch_ms INTEGER NOT NULL,
          activated_at_epoch_ms INTEGER,
          last_seen_at_epoch_ms INTEGER,
          lms_session_state TEXT NOT NULL,
          app_version TEXT
        );
        CREATE TABLE app_session (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          installation_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          label TEXT,
          token_sha256 TEXT NOT NULL UNIQUE,
          created_at_epoch_ms INTEGER NOT NULL,
          expires_at_epoch_ms INTEGER NOT NULL,
          last_seen_at_epoch_ms INTEGER NOT NULL,
          revoked_at_epoch_ms INTEGER,
          source_pairing_id TEXT UNIQUE
        );
        CREATE UNIQUE INDEX app_session_active_desktop_installation
          ON app_session (installation_id)
          WHERE kind = 'desktop' AND revoked_at_epoch_ms IS NULL;
        CREATE TABLE attendance_preference (
          user_id TEXT PRIMARY KEY,
          enabled INTEGER NOT NULL DEFAULT 1,
          morning_enabled INTEGER NOT NULL,
          evening_enabled INTEGER NOT NULL,
          morning_start_hour INTEGER NOT NULL DEFAULT 9,
          evening_end_hour INTEGER NOT NULL DEFAULT 4,
          morning_interval_minutes INTEGER NOT NULL DEFAULT 15,
          evening_interval_minutes INTEGER NOT NULL DEFAULT 15,
          skip_sunday INTEGER NOT NULL,
          skip_attendance_date TEXT,
          updated_at_epoch_ms INTEGER NOT NULL
        );
      `);
      const store = new D1RenewalStore(sqliteD1(database));
      const firstAt = Date.parse("2026-08-03T00:00:00.000Z");
      const secondAt = firstAt + 1;

      expect(await store.enrollDesktop({
          candidateUserId: "user-a",
          installationId: "shared-desktop",
          sessionId: "session-a",
          tokenSha256: "1".repeat(64),
          nowEpochMs: firstAt,
          expiresAtEpochMs: firstAt + 60_000,
        })).toBe(true);
      expect(await store.enrollDesktop({
          candidateUserId: "user-b",
          installationId: "shared-desktop",
          sessionId: "session-b",
          tokenSha256: "2".repeat(64),
          nowEpochMs: secondAt,
          expiresAtEpochMs: secondAt + 60_000,
        })).toBe(false);

      await expect(store.getAttendancePreference("user-a")).resolves.toEqual({
        enabled: true,
        morning: true,
        evening: true,
        morningStartHour: 9,
        eveningEndHour: 4,
        morningIntervalMinutes: 15,
        eveningIntervalMinutes: 15,
        skipSunday: false,
        skipAttendanceDate: null,
      });
      await store.setAttendancePreference("user-a", {
        enabled: false,
        morning: true,
        evening: false,
        morningStartHour: 4,
        eveningEndHour: 0,
        morningIntervalMinutes: 3,
        eveningIntervalMinutes: 30,
        skipSunday: true,
        skipAttendanceDate: "2026-08-03",
      }, secondAt);
      await expect(store.getAttendancePreference("user-a")).resolves.toMatchObject({
        enabled: false,
        morningStartHour: 4,
        eveningEndHour: 0,
        morningIntervalMinutes: 3,
        eveningIntervalMinutes: 30,
      });
      await store.setLegacyAttendancePreference("user-a", {
        morning: false,
        evening: true,
        skipSunday: false,
        skipAttendanceDate: null,
      }, secondAt + 1);
      await expect(store.getAttendancePreference("user-a")).resolves.toEqual({
        enabled: false,
        morning: false,
        evening: true,
        morningStartHour: 4,
        eveningEndHour: 0,
        morningIntervalMinutes: 3,
        eveningIntervalMinutes: 30,
        skipSunday: false,
        skipAttendanceDate: null,
      });
      await expect(store.listAttendanceSubscriberUserIds("morning")).resolves.toEqual([]);

      expect(database.prepare(`SELECT user_id FROM desktop_device WHERE installation_id = ?`)
        .get("shared-desktop")).toEqual({ user_id: "user-a" });
      expect(database.prepare(`SELECT id, user_id FROM app_session
        WHERE installation_id = ? AND kind = 'desktop' AND revoked_at_epoch_ms IS NULL`)
        .all("shared-desktop")).toEqual([{ id: "session-a", user_id: "user-a" }]);
      await expect(store.hasCurrentDesktopOwnership({
        sessionId: "session-a",
        userId: "user-a",
        installationId: "shared-desktop",
      })).resolves.toBe(true);
      expect(await store.rotateDesktopSession({
        currentSessionId: "session-a", userId: "user-a", installationId: "shared-desktop",
        newSessionId: "session-rotated", tokenSha256: "3".repeat(64),
        nowEpochMs: secondAt, expiresAtEpochMs: secondAt + 60_000,
      })).toBe(true);
      await expect(store.hasCurrentDesktopOwnership({
        sessionId: "session-a", userId: "user-a", installationId: "shared-desktop",
      })).resolves.toBe(false);
      await expect(store.hasCurrentDesktopOwnership({
        sessionId: "session-rotated", userId: "user-a", installationId: "shared-desktop",
      })).resolves.toBe(true);
      expect(database.prepare("SELECT id FROM app_user ORDER BY id").all()).toEqual([{ id: "user-a" }]);
    } finally {
      database.close();
    }
  });
});

describe("D1RenewalStore notification delivery", () => {
  it("fans one account event out to every desktop and active Push target with per-desktop ACK", async () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(readFileSync(new URL("../../database/schema.sql", import.meta.url), "utf8"));
      const now = Date.parse("2026-08-03T00:00:00.000Z");
      database.prepare("INSERT INTO app_user (id, created_at_epoch_ms) VALUES (?, ?)").run("user-1", now);
      for (const installationId of ["desktop-1", "desktop-2"]) {
        database.prepare(`INSERT INTO desktop_device (installation_id, user_id, created_at_epoch_ms,
          last_seen_at_epoch_ms, lms_session_state, app_version)
          VALUES (?, 'user-1', ?, ?, 'connected', '0.5.0')`).run(installationId, now, now);
        database.prepare(`INSERT INTO app_session (id, user_id, installation_id, kind, label, token_sha256,
          created_at_epoch_ms, expires_at_epoch_ms, last_seen_at_epoch_ms, revoked_at_epoch_ms, source_pairing_id)
          VALUES (?, 'user-1', ?, 'desktop', NULL, ?, ?, ?, ?, NULL, NULL)`)
          .run(`session-${installationId}`, installationId, installationId === "desktop-1" ? "1".repeat(64) : "2".repeat(64),
            now, now + 60_000, now);
      }
      database.prepare(`INSERT INTO app_session (id, user_id, installation_id, kind, label, token_sha256,
        created_at_epoch_ms, expires_at_epoch_ms, last_seen_at_epoch_ms, revoked_at_epoch_ms, source_pairing_id)
        VALUES ('mobile-session', 'user-1', 'mobile-1', 'mobile', 'Phone', ?, ?, ?, ?, NULL, NULL)`)
        .run("3".repeat(64), now, now + 60_000, now);
      database.prepare(`INSERT INTO push_subscription (id, user_id, session_id, endpoint, p256dh, auth,
        created_at_epoch_ms, revoked_at_epoch_ms) VALUES ('push-1', 'user-1', 'mobile-session', ?, 'key', 'auth', ?, NULL)`)
        .run("https://fcm.googleapis.com/fcm/send/one", now);

      const store = new D1RenewalStore(sqliteD1(database));
      expect(await store.insertNotification({
        id: "notification-1", userId: "user-1", sourceEventId: "event-1", kind: "test",
        title: "Test", body: "Body", path: "/", payloadJson: "{}", createdAtEpochMs: now,
        dueAtEpochMs: now, expiresAtEpochMs: now + 60_000, desktopAttempt: 0,
      })).toBe(true);
      expect(database.prepare(`SELECT target_kind, target_id FROM notification_delivery
        WHERE notification_id = 'notification-1' ORDER BY target_kind, target_id`).all()).toEqual([
        { target_kind: "desktop", target_id: "desktop-1" },
        { target_kind: "desktop", target_id: "desktop-2" },
        { target_kind: "push", target_id: "push-1" },
      ]);
      await expect(store.listDesktopInbox("user-1", "desktop-1", now, 20)).resolves.toHaveLength(1);
      await expect(store.acknowledgeNotification("user-1", "desktop-1", "notification-1", "displayed", now)).resolves.toBe(true);
      await expect(store.listDesktopInbox("user-1", "desktop-1", now + 5_000, 20)).resolves.toHaveLength(0);
      await expect(store.listDesktopInbox("user-1", "desktop-2", now, 20)).resolves.toHaveLength(1);

      expect(await store.insertNotification({
        id: "notification-2", userId: "user-1", sourceEventId: "event-2", kind: "test",
        title: "Test 2", body: "Body 2", path: "/", payloadJson: "{}", createdAtEpochMs: now,
        dueAtEpochMs: now, expiresAtEpochMs: now + 60_000, desktopAttempt: 0,
      })).toBe(true);
      const claimed = await store.claimDuePushDeliveries({
        nowEpochMs: now, limit: 20, leaseToken: "lease-1", leaseExpiresAtEpochMs: now + 60_000,
      });
      expect(claimed).toHaveLength(2);
      expect(await store.insertNotification({
        id: "notification-3", userId: "user-1", sourceEventId: "event-3", kind: "test",
        title: "Test 3", body: "Body 3", path: "/", payloadJson: "{}", createdAtEpochMs: now,
        dueAtEpochMs: now, expiresAtEpochMs: now + 60_000, desktopAttempt: 0,
      })).toBe(true);
      await store.recordPushDeliveryResults(claimed.map((delivery) => ({
        notificationId: delivery.notificationId, subscriptionId: "push-1",
        leaseToken: delivery.leaseToken, status: "gone" as const,
        nowEpochMs: now, nextAttemptAtEpochMs: null, error: "HTTP_410",
      })));
      expect(database.prepare("SELECT revoked_at_epoch_ms FROM push_subscription WHERE id = 'push-1'").get())
        .toEqual({ revoked_at_epoch_ms: now });
      expect(database.prepare(`SELECT notification_id, status, last_error FROM notification_delivery
        WHERE target_kind = 'push' ORDER BY notification_id`).all()).toEqual([
        { notification_id: "notification-1", status: "gone", last_error: "HTTP_410" },
        { notification_id: "notification-2", status: "gone", last_error: "HTTP_410" },
        { notification_id: "notification-3", status: "failed", last_error: "PUSH_SUBSCRIPTION_GONE" },
      ]);
      await expect(store.claimDuePushDeliveries({
        nowEpochMs: now, limit: 20, leaseToken: "lease-2", leaseExpiresAtEpochMs: now + 60_000,
      })).resolves.toHaveLength(0);
    } finally {
      database.close();
    }
  });

  it("revokes a mobile session, its subscriptions, and every pending delivery together", async () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(readFileSync(new URL("../../database/schema.sql", import.meta.url), "utf8"));
      const now = Date.parse("2026-08-03T00:00:00.000Z");
      database.prepare("INSERT INTO app_user (id, created_at_epoch_ms) VALUES ('user-1', ?)").run(now);
      database.prepare(`INSERT INTO app_session (id, user_id, installation_id, kind, label, token_sha256,
        created_at_epoch_ms, expires_at_epoch_ms, last_seen_at_epoch_ms, revoked_at_epoch_ms, source_pairing_id)
        VALUES ('mobile-session', 'user-1', 'mobile-1', 'mobile', 'Phone', ?, ?, ?, ?, NULL, NULL)`)
        .run("4".repeat(64), now, now + 60_000, now);
      database.prepare(`INSERT INTO push_subscription (id, user_id, session_id, endpoint, p256dh, auth,
        created_at_epoch_ms, revoked_at_epoch_ms) VALUES ('push-1', 'user-1', 'mobile-session', ?, 'key', 'auth', ?, NULL)`)
        .run("https://fcm.googleapis.com/fcm/send/one", now);
      database.prepare(`INSERT INTO notification (id, user_id, source_event_id, kind, title, body, path,
        payload_json, created_at_epoch_ms, due_at_epoch_ms, expires_at_epoch_ms)
        VALUES ('notification-1', 'user-1', 'event-1', 'test', 'Test', 'Body', '/', '{}', ?, ?, ?)`)
        .run(now, now, now + 60_000);
      const store = new D1RenewalStore(sqliteD1(database));
      await expect(store.revokeMobileSession("user-1", "mobile-session", now)).resolves.toBe(true);
      expect(database.prepare("SELECT revoked_at_epoch_ms FROM app_session WHERE id = 'mobile-session'").get())
        .toEqual({ revoked_at_epoch_ms: now });
      expect(database.prepare("SELECT revoked_at_epoch_ms FROM push_subscription WHERE id = 'push-1'").get())
        .toEqual({ revoked_at_epoch_ms: now });
      expect(database.prepare(`SELECT status, last_error FROM notification_delivery
        WHERE notification_id = 'notification-1' AND target_id = 'push-1'`).get())
        .toEqual({ status: "failed", last_error: "MOBILE_SESSION_REVOKED" });
    } finally {
      database.close();
    }
  });
});

describe("D1RenewalStore laundry lifecycle", () => {
  it("inserts and fans out 64 availability notifications below the D1 Free 50-query limit", async () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(readFileSync(new URL("../../database/schema.sql", import.meta.url), "utf8"));
      const now = Date.parse("2026-08-10T03:00:00.000Z");
      for (let index = 0; index < 64; index += 1) {
        const userId = `user-${index}`;
        const desktopId = `desktop-${index}`;
        const mobileId = `mobile-${index}`;
        database.prepare("INSERT INTO app_user (id, created_at_epoch_ms) VALUES (?, ?)").run(userId, now);
        database.prepare(`INSERT INTO desktop_device (installation_id, user_id, created_at_epoch_ms,
          last_seen_at_epoch_ms, lms_session_state, app_version) VALUES (?, ?, ?, ?, 'connected', '0.5.0')`)
          .run(desktopId, userId, now, now);
        database.prepare(`INSERT INTO app_session (id, user_id, installation_id, kind, label, token_sha256,
          created_at_epoch_ms, expires_at_epoch_ms, last_seen_at_epoch_ms, revoked_at_epoch_ms, source_pairing_id)
          VALUES (?, ?, ?, 'desktop', NULL, ?, ?, ?, ?, NULL, NULL),
            (?, ?, ?, 'mobile', 'Phone', ?, ?, ?, ?, NULL, NULL)`)
          .run(`desktop-session-${index}`, userId, desktopId, String(index * 2).padStart(64, "0"),
            now, now + 60_000, now,
            `mobile-session-${index}`, userId, mobileId, String(index * 2 + 1).padStart(64, "0"),
            now, now + 60_000, now);
        database.prepare(`INSERT INTO push_subscription (id, user_id, session_id, endpoint, p256dh, auth,
          created_at_epoch_ms, revoked_at_epoch_ms) VALUES (?, ?, ?, ?, 'key', 'auth', ?, NULL)`)
          .run(`push-${index}`, userId, `mobile-session-${index}`,
            `https://fcm.googleapis.com/fcm/send/${index}`, now);
        database.prepare(`INSERT INTO laundry_watch (id, user_id, machine_id, appliance, session_id,
          notify_before_minutes, notify_when_available, status, created_at_epoch_ms, updated_at_epoch_ms)
          VALUES (?, ?, 'tower-3', 'washer', NULL, 5, 1, 'active', ?, ?)`)
          .run(`watch-${index}`, userId, now, now);
      }
      const event = {
        sourceEventId: "availability-64", machineId: "tower-3", appliance: "washer" as const,
        sessionId: null, previousState: "BUSY" as const, currentState: "AVAILABLE" as const,
        remainingMinutes: 0, occurredAtEpochMs: now,
      };
      const watches = await new D1RenewalStore(sqliteD1(database)).listActiveLaundryWatches({
        machineId: "tower-3", appliance: "washer", sessionId: null,
      });
      const planned = planLaundryTransition(event, watches);
      let largestBatch = 0;
      const store = new D1RenewalStore(sqliteD1(database, (count) => { largestBatch = Math.max(largestBatch, count); }));

      await expect(store.applyLaundryLifecycleEvent({
        eventId: event.sourceEventId, processingToken: "processing-64", notifications: planned,
        completedWatchIds: [], nowEpochMs: now,
      })).resolves.toBe(true);

      expect(planned).toHaveLength(64);
      expect(largestBatch).toBeLessThanOrEqual(50);
      expect(database.prepare("SELECT count(*) AS count FROM notification").get()).toEqual({ count: 64 });
      expect(database.prepare("SELECT count(*) AS count FROM notification_delivery").get()).toEqual({ count: 128 });
    } finally {
      database.close();
    }
  });

});

describe("D1RenewalStore housekeeping", () => {
  it("retries immediately after a failed cleanup transaction instead of persisting the hourly guard", async () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(readFileSync(new URL("../../database/schema.sql", import.meta.url), "utf8"));
      const delegate = sqliteD1(database);
      let failBatch = true;
      const flaky = {
        prepare: (sql: string) => delegate.prepare(sql),
        batch: async (statements: SqlPreparedStatement[]) => {
          if (failBatch) {
            failBatch = false;
            throw new Error("simulated D1 batch failure");
          }
          return delegate.batch(statements);
        },
      } as unknown as SqlDatabase;
      const store = new D1RenewalStore(flaky);
      const now = Date.parse("2026-08-10T03:00:00.000Z");

      await expect(store.runHousekeeping(now)).rejects.toThrow("simulated D1 batch failure");
      expect(database.prepare("SELECT * FROM maintenance_state").all()).toEqual([]);
      await expect(store.runHousekeeping(now)).resolves.toBe(true);
      expect(database.prepare(`SELECT last_run_at_epoch_ms FROM maintenance_state
        WHERE name = 'retention'`).get()).toEqual({ last_run_at_epoch_ms: now });
    } finally {
      database.close();
    }
  });

  it("runs hourly, removes only expired artifacts, and preserves active personal state", async () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(readFileSync(new URL("../../database/schema.sql", import.meta.url), "utf8"));
      const now = Date.parse("2026-08-10T03:00:00.000Z");
      const old30 = now - 31 * 24 * 60 * 60_000;
      const old7 = now - 8 * 24 * 60 * 60_000;
      database.prepare("INSERT INTO app_user (id, created_at_epoch_ms) VALUES ('user-1', ?)").run(old30);
      database.prepare(`INSERT INTO desktop_device (installation_id, user_id, created_at_epoch_ms,
        last_seen_at_epoch_ms, lms_session_state, app_version)
        VALUES ('desktop-1', 'user-1', ?, ?, 'connected', '0.5.0')`).run(old30, now);
      database.prepare(`INSERT INTO desktop_device (installation_id, user_id, created_at_epoch_ms,
        last_seen_at_epoch_ms, lms_session_state, app_version)
        VALUES ('desktop-old', 'user-1', ?, ?, 'unknown', '0.4.0')`).run(old30, old30);
      for (const installationId of ["desktop-ui-expired", "desktop-ui-revoked"]) {
        database.prepare(`INSERT INTO desktop_device (installation_id, user_id, created_at_epoch_ms,
          last_seen_at_epoch_ms, lms_session_state, app_version)
          VALUES (?, 'user-1', ?, ?, 'unknown', '0.5.0')`).run(installationId, old30, now);
      }
      database.prepare(`INSERT INTO app_session (id, user_id, installation_id, kind, label, token_sha256,
        created_at_epoch_ms, expires_at_epoch_ms, last_seen_at_epoch_ms, revoked_at_epoch_ms, source_pairing_id)
        VALUES ('desktop-active', 'user-1', 'desktop-1', 'desktop', NULL, ?, ?, ?, ?, NULL, NULL),
        ('desktop-retired', 'user-1', 'desktop-old', 'desktop', NULL, ?, ?, ?, ?, ?, NULL)`)
        .run("a".repeat(64), now, now + 60_000, now, "b".repeat(64), old30, old30, old30, old30);
      database.prepare(`INSERT INTO app_session (id, user_id, installation_id, kind, label, token_sha256,
        created_at_epoch_ms, expires_at_epoch_ms, last_seen_at_epoch_ms, revoked_at_epoch_ms, source_pairing_id)
        VALUES ('desktop-ui-expired-parent', 'user-1', 'desktop-ui-expired', 'desktop', NULL, ?, ?, ?, ?, NULL, NULL),
        ('desktop-ui-revoked-parent', 'user-1', 'desktop-ui-revoked', 'desktop', NULL, ?, ?, ?, ?, ?, NULL)`)
        .run("c".repeat(64), old30, now - 1, now,
          "d".repeat(64), old30, now + 60_000, now, now - 1);
      database.prepare(`INSERT INTO desktop_ui_session
        (id, parent_session_id, user_id, installation_id, token_sha256, origin, scope,
          created_at_epoch_ms, expires_at_epoch_ms)
        VALUES ('ui-active', 'desktop-active', 'user-1', 'desktop-1', ?, 'tauri://localhost',
          'desktop-ui-v1', ?, ?),
        ('ui-expired', 'desktop-ui-expired-parent', 'user-1', 'desktop-ui-expired', ?, 'tauri://localhost',
          'desktop-ui-v1', ?, ?),
        ('ui-revoked', 'desktop-ui-revoked-parent', 'user-1', 'desktop-ui-revoked', ?, 'tauri://localhost',
          'desktop-ui-v1', ?, ?)`)
        .run("e".repeat(64), now - 1, now + 60_000,
          "f".repeat(64), now - 60_000, now - 1,
          "0".repeat(64), now - 1, now + 60_000);
      for (const [id, installationId, expiresAt, revokedAt, hash] of [
        ["mobile-active", "phone-active", now + 60_000, null, "5".repeat(64)],
        ["mobile-old", "phone-old", old30, old30, "6".repeat(64)],
      ] as const) {
        database.prepare(`INSERT INTO app_session (id, user_id, installation_id, kind, label, token_sha256,
          created_at_epoch_ms, expires_at_epoch_ms, last_seen_at_epoch_ms, revoked_at_epoch_ms, source_pairing_id)
          VALUES (?, 'user-1', ?, 'mobile', 'Phone', ?, ?, ?, ?, ?, NULL)`)
          .run(id, installationId, hash, old30, expiresAt, old30, revokedAt);
      }
      database.prepare(`INSERT INTO push_subscription (id, user_id, session_id, endpoint, p256dh, auth,
        created_at_epoch_ms, revoked_at_epoch_ms) VALUES ('push-active', 'user-1', 'mobile-active',
        'https://push.example/active', 'key', 'auth', ?, NULL)`).run(now);
      database.prepare(`INSERT INTO push_subscription (id, user_id, session_id, endpoint, p256dh, auth,
        created_at_epoch_ms, revoked_at_epoch_ms) VALUES ('push-old', 'user-1', 'mobile-old',
        'https://push.example/old', 'key', 'auth', ?, ?)`).run(old30, old30);
      database.prepare(`INSERT INTO pairing_challenge (id, user_id, desktop_installation_id,
        pairing_secret_sha256, manual_code_hash, claim_receipt_sha256, status, mobile_installation_id,
        mobile_label, created_at_epoch_ms, expires_at_epoch_ms, approved_at_epoch_ms)
        VALUES ('pairing-old', 'user-1', 'desktop-1', ?, ?, ?, 'consumed', 'phone-old', 'Phone', ?, ?, ?)`)
        .run("7".repeat(64), "8".repeat(64), "9".repeat(64), old7, old7, old7);
      database.prepare(`INSERT INTO laundry_watch (id, user_id, machine_id, appliance, session_id,
        notify_before_minutes, notify_when_available, status, created_at_epoch_ms, updated_at_epoch_ms)
        VALUES ('watch-active', 'user-1', 'tower-3', 'washer', NULL, 5, 1, 'active', ?, ?),
        ('watch-old', 'user-1', 'tower-4', 'washer', NULL, 5, 1, 'completed', ?, ?)`)
        .run(old30, now, old30, old30);
      for (const [id, observedAt] of [["event-active", now], ["event-old", old30]] as const) {
        database.prepare(`INSERT INTO laundry_event (id, machine_id, appliance, session_id, type,
          previous_observed_at, observed_at, eta_delta_minutes, previous_state, current_state, detail_json)
          VALUES (?, 'tower-3', 'washer', NULL, 'STATE_CHANGED', NULL, ?, NULL, NULL, 'RUNNING', '{}')`)
          .run(id, new Date(observedAt).toISOString());
        database.prepare(`INSERT INTO laundry_lifecycle_processing
          (source_id, processing_token, processed_at_epoch_ms) VALUES (?, ?, ?)`)
          .run(id, `token-${id}`, observedAt);
      }

      const store = new D1RenewalStore(sqliteD1(database));
      await expect(store.runHousekeeping(now)).resolves.toBe(true);
      await expect(store.runHousekeeping(now + 59 * 60_000)).resolves.toBe(false);

      expect(database.prepare("SELECT id FROM app_session ORDER BY id").all()).toEqual([
        { id: "desktop-active" }, { id: "desktop-ui-expired-parent" },
        { id: "desktop-ui-revoked-parent" }, { id: "mobile-active" },
      ]);
      expect(database.prepare("SELECT id FROM desktop_ui_session ORDER BY id").all())
        .toEqual([{ id: "ui-active" }]);
      await expect(store.hasCurrentDesktopOwnership({
        sessionId: "desktop-active", userId: "user-1", installationId: "desktop-1",
      })).resolves.toBe(true);
      expect(database.prepare("SELECT id FROM push_subscription ORDER BY id").all()).toEqual([{ id: "push-active" }]);
      expect(database.prepare("SELECT id FROM pairing_challenge").all()).toEqual([]);
      expect(database.prepare("SELECT id FROM laundry_watch").all()).toEqual([{ id: "watch-active" }]);
      expect(database.prepare("SELECT id FROM laundry_event").all()).toEqual([{ id: "event-active" }]);
      expect(database.prepare("SELECT source_id FROM laundry_lifecycle_processing").all())
        .toEqual([{ source_id: "event-active" }]);
    } finally {
      database.close();
    }
  });

  it("removes abandoned enrollment rows after 24 hours but preserves every durable use signal", async () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(readFileSync(new URL("../../database/schema.sql", import.meta.url), "utf8"));
      const store = new D1RenewalStore(sqliteD1(database));
      const now = Date.parse("2026-08-10T03:00:00.000Z");
      const old = now - DESKTOP_ENROLLMENT_POLICY.abandonedRetentionMs - 1;
      let token = 0;
      const enroll = async (userId: string, installationId: string, createdAt: number, expiresAt = now + 60_000) => {
        token += 1;
        expect(await store.enrollDesktop({
          candidateUserId: userId,
          installationId,
          sessionId: `session-${installationId}`,
          tokenSha256: token.toString(16).padStart(64, "0"),
          nowEpochMs: createdAt,
          expiresAtEpochMs: expiresAt,
        })).toBe(true);
      };

      await enroll("user-abandoned", "desktop-abandoned", old);
      await enroll("user-recent", "desktop-recent", now - DESKTOP_ENROLLMENT_POLICY.abandonedRetentionMs + 1);

      await enroll("user-heartbeat", "desktop-heartbeat", old);
      await store.recordDesktopHeartbeat({
        userId: "user-heartbeat", installationId: "desktop-heartbeat",
        lmsSessionState: "unknown", appVersion: null, nowEpochMs: old + 1,
      });

      await enroll("user-rotated", "desktop-rotated", old);
      expect(await store.rotateDesktopSession({
        currentSessionId: "session-desktop-rotated", userId: "user-rotated",
        installationId: "desktop-rotated", newSessionId: "session-desktop-rotated-next",
        tokenSha256: (++token).toString(16).padStart(64, "0"), nowEpochMs: old + 1,
        expiresAtEpochMs: now + 60_000,
      })).toBe(true);

      await enroll("user-pairing", "desktop-pairing", old);
      expect(await store.createPairing({
        id: "jbp_00000000-0000-4000-8000-000000000001", userId: "user-pairing",
        desktopInstallationId: "desktop-pairing", pairingSecretSha256: "a".repeat(64),
        manualCodeHash: "b".repeat(64), claimReceiptSha256: null, status: "pending",
        mobileInstallationId: null, mobileLabel: null, createdAtEpochMs: old + 1,
        expiresAtEpochMs: now + 60_000, approvedAtEpochMs: null,
      })).toBe(true);

      await enroll("user-mobile", "desktop-mobile", old);
      database.prepare(`INSERT INTO app_session (id, user_id, installation_id, kind, label, token_sha256,
        created_at_epoch_ms, expires_at_epoch_ms, last_seen_at_epoch_ms, revoked_at_epoch_ms, source_pairing_id)
        VALUES ('mobile-valid', 'user-mobile', 'phone-valid', 'mobile', 'Phone', ?, ?, ?, ?, NULL, NULL)`)
        .run((++token).toString(16).padStart(64, "0"), old, now + 60_000, now);

      const expired = now - 31 * 24 * 60 * 60_000;
      await enroll("user-expired", "desktop-expired", old, expired);
      await store.recordDesktopHeartbeat({
        userId: "user-expired", installationId: "desktop-expired",
        lmsSessionState: "connected", appVersion: "0.5.0", nowEpochMs: old + 1,
      });

      await expect(store.runHousekeeping(now)).resolves.toBe(true);

      expect(database.prepare("SELECT id FROM app_user ORDER BY id").all()).toEqual([
        { id: "user-heartbeat" }, { id: "user-mobile" }, { id: "user-pairing" },
        { id: "user-recent" }, { id: "user-rotated" },
      ]);
      expect(database.prepare(`SELECT installation_id, activated_at_epoch_ms FROM desktop_device
        WHERE installation_id IN ('desktop-heartbeat', 'desktop-pairing', 'desktop-rotated')
        ORDER BY installation_id`).all()).toEqual([
        { installation_id: "desktop-heartbeat", activated_at_epoch_ms: old + 1 },
        { installation_id: "desktop-pairing", activated_at_epoch_ms: old + 1 },
        { installation_id: "desktop-rotated", activated_at_epoch_ms: old + 1 },
      ]);
      expect(database.prepare("SELECT 1 FROM desktop_device WHERE installation_id = 'desktop-abandoned'").get())
        .toBeUndefined();
      expect(database.prepare("SELECT 1 FROM app_session WHERE user_id = 'user-abandoned'").get())
        .toBeUndefined();
      expect(database.prepare("SELECT 1 FROM attendance_preference WHERE user_id = 'user-abandoned'").get())
        .toBeUndefined();
      expect(database.prepare("SELECT id FROM app_session WHERE id = 'mobile-valid'").get())
        .toEqual({ id: "mobile-valid" });
    } finally {
      database.close();
    }
  });
});
