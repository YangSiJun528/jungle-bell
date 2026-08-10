import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { D1RenewalStore, type AppSessionRecord } from "../src/workers/account-storage";

interface BoundStatement {
  sql: string;
  values: SQLInputValue[];
}

function sqliteD1(database: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind(...values: SQLInputValue[]) {
          return {
            sql,
            values,
            async first<T>() {
              return (database.prepare(sql).get(...values) as T | undefined) ?? null;
            },
          } as unknown as D1PreparedStatement;
        },
      } as unknown as D1PreparedStatement;
    },
    async batch(statements: D1PreparedStatement[]) {
      database.exec("BEGIN IMMEDIATE");
      try {
        const results = statements.map((raw) => {
          const statement = raw as unknown as BoundStatement;
          const result = database.prepare(statement.sql).run(...statement.values);
          return { meta: { changes: Number(result.changes) } } as unknown as D1Result;
        });
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
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

      const store = new D1RenewalStore(sqliteD1(database));
      const winner = mobileSession("winning-session", now);
      expect(await store.approvePairing("pairing-1", "desktop-1", winner, now)).toBe(true);
      expect(database.prepare("SELECT revoked_at_epoch_ms FROM app_session WHERE id = ?").get("old-session"))
        .toEqual({ revoked_at_epoch_ms: now });
      expect(database.prepare("SELECT revoked_at_epoch_ms FROM push_subscription WHERE id = ?").get("old-push"))
        .toEqual({ revoked_at_epoch_ms: now });

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

describe("D1RenewalStore desktop verification", () => {
  it("atomically leaves one current owner and one active session for a shared installation", async () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(`
        CREATE TABLE app_user (
          id TEXT PRIMARY KEY,
          lms_subject_sha256 TEXT NOT NULL UNIQUE,
          created_at_epoch_ms INTEGER NOT NULL,
          last_verified_at_epoch_ms INTEGER NOT NULL
        );
        CREATE TABLE desktop_device (
          installation_id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          created_at_epoch_ms INTEGER NOT NULL,
          last_verified_at_epoch_ms INTEGER NOT NULL,
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
          morning_enabled INTEGER NOT NULL,
          evening_enabled INTEGER NOT NULL,
          skip_sunday INTEGER NOT NULL,
          skip_attendance_date TEXT,
          updated_at_epoch_ms INTEGER NOT NULL
        );
      `);
      const store = new D1RenewalStore(sqliteD1(database));
      const firstAt = Date.parse("2026-08-03T00:00:00.000Z");
      const secondAt = firstAt + 1;

      await Promise.all([
        store.issueVerifiedDesktopSession({
          candidateUserId: "user-a",
          subjectSha256: "a".repeat(64),
          installationId: "shared-desktop",
          sessionId: "session-a",
          tokenSha256: "1".repeat(64),
          nowEpochMs: firstAt,
          expiresAtEpochMs: firstAt + 60_000,
        }),
        store.issueVerifiedDesktopSession({
          candidateUserId: "user-b",
          subjectSha256: "b".repeat(64),
          installationId: "shared-desktop",
          sessionId: "session-b",
          tokenSha256: "2".repeat(64),
          nowEpochMs: secondAt,
          expiresAtEpochMs: secondAt + 60_000,
        }),
      ]);

      expect(database.prepare(`SELECT user_id FROM desktop_device WHERE installation_id = ?`)
        .get("shared-desktop")).toEqual({ user_id: "user-b" });
      expect(database.prepare(`SELECT id, user_id FROM app_session
        WHERE installation_id = ? AND kind = 'desktop' AND revoked_at_epoch_ms IS NULL`)
        .all("shared-desktop")).toEqual([{ id: "session-b", user_id: "user-b" }]);
      expect(database.prepare("SELECT revoked_at_epoch_ms FROM app_session WHERE id = ?")
        .get("session-a")).toEqual({ revoked_at_epoch_ms: secondAt });
      await expect(store.hasCurrentDesktopOwnership({
        sessionId: "session-a",
        userId: "user-a",
        installationId: "shared-desktop",
      })).resolves.toBe(false);
      await expect(store.hasCurrentDesktopOwnership({
        sessionId: "session-b",
        userId: "user-b",
        installationId: "shared-desktop",
      })).resolves.toBe(true);
    } finally {
      database.close();
    }
  });
});
