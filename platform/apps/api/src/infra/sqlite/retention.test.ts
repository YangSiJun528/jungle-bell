import { describe, expect, it } from "vitest";

import {
  SqliteNotificationRepository,
} from "../../notifications/repository.js";
import {
  LAUNDRY_TERMINAL_RETENTION_MS,
  NOTIFICATION_TERMINAL_RETENTION_MS,
  PAIRING_ARTIFACT_RETENTION_MS,
  SESSION_TERMINAL_RETENTION_MS,
  SqliteRetentionPruner,
} from "./retention.js";
import { openSqliteDatabase } from "./database.js";

const DAY_MS = 24 * 60 * 60 * 1_000;

describe("SQLite retention pruning", () => {
  it("deletes only terminal rows past the documented retention windows", () => {
    const database = openSqliteDatabase(":memory:");
    const notifications = new SqliteNotificationRepository(database);
    const now = 100 * DAY_MS;
    seedTerminalNotification(notifications, "old-terminal", 1);
    const recentCreatedAt =
      now - NOTIFICATION_TERMINAL_RETENTION_MS + 1;
    seedTerminalNotification(
      notifications,
      "recent-terminal",
      recentCreatedAt,
    );
    notifications.enqueueIntent(
      notificationIntent("old-active", 2),
      2,
    );
    seedPairingRows(database, now);
    seedLaundryRows(database, now);

    const result = new SqliteRetentionPruner(database).prune(now);
    expect(result).toEqual({
      notificationEvents: 1,
      laundryWatches: 2,
      laundryQueueEntries: 2,
      laundryQueueClaims: 1,
      pairingTransports: 2,
      pushSubscriptions: 1,
      desktopSessions: 1,
      deviceSessions: 1,
      pairingChallenges: 2,
    });
    expect(
      database
        .prepare(`
          SELECT source_event_id
          FROM notification_events
          ORDER BY source_event_id
        `)
        .all(),
    ).toEqual([
      { source_event_id: "old-active" },
      { source_event_id: "recent-terminal" },
    ]);
    expect(
      database
        .prepare("SELECT session_id FROM device_sessions")
        .all(),
    ).toEqual([{ session_id: "session-recent" }]);
    expect(
      database
        .prepare("SELECT token_hash FROM desktop_sessions")
        .all(),
    ).toEqual([{ token_hash: "desktop-recent-token" }]);
    expect(
      database
        .prepare(
          "SELECT challenge_id FROM pairing_challenges ORDER BY challenge_id",
        )
        .all(),
    ).toEqual([{ challenge_id: "challenge-recent" }]);
    expect(
      database
        .prepare(`
          SELECT id
          FROM user_laundry_watches
          ORDER BY id
        `)
        .all(),
    ).toEqual([
      { id: "watch-active-old" },
      { id: "watch-completed-recent" },
    ]);
    expect(
      database
        .prepare(`
          SELECT id
          FROM laundry_voluntary_queue
          ORDER BY id
        `)
        .all(),
    ).toEqual([
      { id: "queue-expired-recent" },
      { id: "queue-waiting-old" },
    ]);
    expect(
      database
        .prepare("SELECT queue_entry_id FROM laundry_queue_claims")
        .all(),
    ).toEqual([]);
    expect(database.pragma("foreign_key_check")).toEqual([]);
    database.close();
  });

  it("keeps exact policy constants stable", () => {
    expect(LAUNDRY_TERMINAL_RETENTION_MS).toBe(30 * DAY_MS);
    expect(NOTIFICATION_TERMINAL_RETENTION_MS).toBe(30 * DAY_MS);
    expect(SESSION_TERMINAL_RETENTION_MS).toBe(30 * DAY_MS);
    expect(PAIRING_ARTIFACT_RETENTION_MS).toBe(7 * DAY_MS);
  });
});

function seedTerminalNotification(
  repository: SqliteNotificationRepository,
  sourceEventId: string,
  atEpochMs: number,
): void {
  repository.enqueueIntent(
    notificationIntent(sourceEventId, atEpochMs),
    atEpochMs,
  );
  const [claimed] = repository.claimOutbox(
    atEpochMs,
    1,
    1_000,
  );
  if (claimed === undefined) throw new Error("OUTBOX_NOT_CLAIMED");
  repository.completeOutbox(claimed.event.id, atEpochMs);
}

function seedLaundryRows(
  database: ReturnType<typeof openSqliteDatabase>,
  now: number,
): void {
  for (const watch of [
    {
      id: "watch-completed-old",
      status: "completed",
      created: 0,
      updated: 1,
    },
    {
      id: "watch-cancelled-old",
      status: "cancelled",
      created: 0,
      updated: 2,
    },
    {
      id: "watch-completed-recent",
      status: "completed",
      created: now - 1_000,
      updated: now - 500,
    },
    {
      id: "watch-active-old",
      status: "active",
      created: 0,
      updated: 1,
    },
  ] as const) {
    database
      .prepare(`
        INSERT INTO user_laundry_watches (
          id, user_id, machine_id, appliance, session_id,
          notify_before_minutes, notify_when_available, status,
          created_at_epoch_ms, updated_at_epoch_ms
        ) VALUES (
          @id, 'user-1', @id, 'washer', NULL,
          0, 1, @status, @created, @updated
        )
      `)
      .run(watch);
  }

  for (const entry of [
    {
      id: "queue-claimed-old",
      status: "claimed",
      joined: 0,
      left: 1,
    },
    {
      id: "queue-cancelled-old",
      status: "cancelled",
      joined: 0,
      left: 2,
    },
    {
      id: "queue-expired-recent",
      status: "expired",
      joined: now - 1_000,
      left: now - 500,
    },
    {
      id: "queue-waiting-old",
      status: "waiting",
      joined: 0,
      left: null,
    },
  ] as const) {
    database
      .prepare(`
        INSERT INTO laundry_voluntary_queue (
          id, user_id, machine_id, appliance, status,
          joined_at_epoch_ms, left_at_epoch_ms
        ) VALUES (
          @id, 'user-1', @id, 'washer', @status,
          @joined, @left
        )
      `)
      .run(entry);
  }
  database
    .prepare(`
      INSERT INTO laundry_queue_claims (
        queue_entry_id, machine_id, appliance,
        claimed_at_epoch_ms, expires_at_epoch_ms
      ) VALUES (
        'queue-claimed-old', 'queue-claimed-old', 'washer', 1, 2
      )
    `)
    .run();
}

function notificationIntent(
  sourceEventId: string,
  atEpochMs: number,
) {
  return {
    userId: "user-1",
    kind: "meal-published",
    sourceEventId,
    dedupeKey: `dedupe-${sourceEventId}`,
    content: {
      title: "급식",
      body: "메뉴",
      path: "/app#meals",
    },
    metadata: {},
    targetDeviceId: null,
    occurredAtEpochMs: atEpochMs,
    expiresAtEpochMs: atEpochMs + DAY_MS,
  } as const;
}

function seedPairingRows(
  database: ReturnType<typeof openSqliteDatabase>,
  now: number,
): void {
  database
    .prepare(`
      INSERT INTO users (id, status, created_at_epoch_ms)
      VALUES ('user-1', 'active', 0)
    `)
    .run();
  database
    .prepare(`
      INSERT INTO desktop_devices (
        user_id, desktop_device_id, registered_at_epoch_ms,
        last_verified_at_epoch_ms, last_seen_at_epoch_ms,
        lms_session_state, app_version
      ) VALUES (
        'user-1', 'desktop-1', 0, 0, 0, 'connected', NULL
      )
    `)
    .run();
  for (const input of [
    {
      id: "challenge-old-pending",
      status: "pending",
      created: 1,
      expires: 2,
      approved: null,
      label: null,
      installation: null,
    },
    {
      id: "challenge-old-approved",
      status: "approved",
      created: 1,
      expires: 3,
      approved: 2,
      label: "Old phone",
      installation: `jbmi_${"1".repeat(32)}`,
    },
    {
      id: "challenge-recent",
      status: "approved",
      created: now - 1_000,
      expires: now + 1_000,
      approved: now - 500,
      label: "Recent phone",
      installation: `jbmi_${"2".repeat(32)}`,
    },
  ] as const) {
    database
      .prepare(`
        INSERT INTO pairing_challenges (
          challenge_id, user_id, desktop_device_id,
          pairing_code_hash, manual_code_hash, status,
          claimed_device_label, claimed_installation_id,
          created_at_epoch_ms, expires_at_epoch_ms,
          approved_at_epoch_ms, version
        ) VALUES (
          @id, 'user-1', 'desktop-1',
          @pairingHash, @manualHash, @status,
          @label, @installation, @created, @expires,
          @approved, 0
        )
      `)
      .run({
        ...input,
        pairingHash: `pair-${input.id}`,
        manualHash: `manual-${input.id}`,
      });
  }
  for (const [id, expires] of [
    ["challenge-old-pending", 2],
    ["challenge-old-approved", 3],
  ] as const) {
    database
      .prepare(`
        INSERT INTO pairing_claim_transports (
          claim_id, challenge_id, receipt_hash,
          approved_session_ciphertext, created_at_epoch_ms,
          expires_at_epoch_ms, delivered_at_epoch_ms, version
        ) VALUES (
          @claimId, @challengeId, @receiptHash,
          NULL, 1, @expires, NULL, 0
        )
      `)
      .run({
        claimId: `claim-${id}`,
        challengeId: id,
        receiptHash: `receipt-${id}`,
        expires,
      });
  }
  database
    .prepare(`
      INSERT INTO device_sessions (
        session_id, pairing_challenge_id, user_id, device_id,
        device_label, installation_id, token_hash, scopes_json,
        created_at_epoch_ms, expires_at_epoch_ms,
        last_seen_at_epoch_ms, revoked_at_epoch_ms, version
      ) VALUES (
        'session-old', 'challenge-old-approved', 'user-1',
        'device-old', 'Old phone', @installation,
        'mobile-old-token', '[]', 1, 3, 1, 2, 0
      )
    `)
    .run({ installation: `jbmi_${"1".repeat(32)}` });
  database
    .prepare(`
      INSERT INTO device_sessions (
        session_id, pairing_challenge_id, user_id, device_id,
        device_label, installation_id, token_hash, scopes_json,
        created_at_epoch_ms, expires_at_epoch_ms,
        last_seen_at_epoch_ms, revoked_at_epoch_ms, version
      ) VALUES (
        'session-recent', 'challenge-recent', 'user-1',
        'device-recent', 'Recent phone', @installation,
        'mobile-recent-token', '[]', @created, @expires,
        @created, NULL, 0
      )
    `)
    .run({
      installation: `jbmi_${"2".repeat(32)}`,
      created: now - 500,
      expires: now + DAY_MS,
    });
  database
    .prepare(`
      INSERT INTO push_subscriptions (
        id, user_id, device_id, endpoint, expiration_time,
        auth_key, p256dh_key, created_at_epoch_ms,
        updated_at_epoch_ms, revoked_at_epoch_ms, revoked_reason
      ) VALUES (
        'push-old', 'user-1', 'device-old',
        'https://fcm.googleapis.com/push-old', NULL,
        'auth', 'p256dh', 1, 2, 2, 'device-revoked'
      )
    `)
    .run();
  database
    .prepare(`
      INSERT INTO desktop_sessions (
        token_hash, user_id, desktop_device_id,
        created_at_epoch_ms, expires_at_epoch_ms,
        revoked_at_epoch_ms, version
      ) VALUES (
        'desktop-old-token', 'user-1', 'desktop-1',
        1, 2, 2, 0
      ), (
        'desktop-recent-token', 'user-1', 'desktop-1',
        @created, @expires, NULL, 0
      )
    `)
    .run({ created: now - 500, expires: now + DAY_MS });
}
