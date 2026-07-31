import {
  DEFAULT_DEVICE_SESSION_TTL_MS,
} from "../../domain/index.js";
import type { SqliteDatabase } from "./database.js";

const DAY_MS = 24 * 60 * 60 * 1_000;

export const NOTIFICATION_TERMINAL_RETENTION_MS = 30 * DAY_MS;
export const LAUNDRY_TERMINAL_RETENTION_MS = 30 * DAY_MS;
export const SESSION_TERMINAL_RETENTION_MS = 30 * DAY_MS;
export const PAIRING_ARTIFACT_RETENTION_MS = 7 * DAY_MS;
export const RETENTION_PRUNE_INTERVAL_MS = 60 * 60 * 1_000;

export interface RetentionPruneResult {
  readonly notificationEvents: number;
  readonly laundryWatches: number;
  readonly laundryQueueEntries: number;
  readonly laundryQueueClaims: number;
  readonly pairingTransports: number;
  readonly pushSubscriptions: number;
  readonly desktopSessions: number;
  readonly deviceSessions: number;
  readonly pairingChallenges: number;
}

export class SqliteRetentionPruner {
  constructor(private readonly database: SqliteDatabase) {}

  prune(nowEpochMs: number): RetentionPruneResult {
    assertEpoch(nowEpochMs);
    const notificationCutoff =
      nowEpochMs - NOTIFICATION_TERMINAL_RETENTION_MS;
    const laundryCutoff =
      nowEpochMs - LAUNDRY_TERMINAL_RETENTION_MS;
    const sessionCutoff =
      nowEpochMs - SESSION_TERMINAL_RETENTION_MS;
    const pairingCutoff =
      nowEpochMs - PAIRING_ARTIFACT_RETENTION_MS;
    const prune = this.database.transaction(() => {
      const notificationEvents = this.database
        .prepare(`
          DELETE FROM notification_events
          WHERE id IN (
            SELECT e.id
            FROM notification_events e
            JOIN notification_outbox o ON o.event_id = e.id
            WHERE e.created_at_epoch_ms <= @notificationCutoff
              AND o.status IN ('completed', 'failed')
              AND o.updated_at_epoch_ms <= @notificationCutoff
              AND NOT EXISTS (
                SELECT 1
                FROM notification_deliveries d
                WHERE d.event_id = e.id
                  AND (
                    d.status NOT IN ('delivered', 'failed', 'cancelled')
                    OR d.updated_at_epoch_ms > @notificationCutoff
                  )
              )
          )
        `)
        .run({ notificationCutoff }).changes;
      const laundryWatches = this.database
        .prepare(`
          DELETE FROM user_laundry_watches
          WHERE status IN ('completed', 'cancelled')
            AND updated_at_epoch_ms <= @laundryCutoff
        `)
        .run({ laundryCutoff }).changes;
      const laundryQueueClaims = this.database
        .prepare(`
          DELETE FROM laundry_queue_claims
          WHERE expires_at_epoch_ms <= @laundryCutoff
        `)
        .run({ laundryCutoff }).changes;
      const laundryQueueEntries = this.database
        .prepare(`
          DELETE FROM laundry_voluntary_queue
          WHERE status IN ('claimed', 'cancelled', 'expired')
            AND left_at_epoch_ms <= @laundryCutoff
        `)
        .run({ laundryCutoff }).changes;
      const pairingTransports = this.database
        .prepare(`
          DELETE FROM pairing_claim_transports
          WHERE expires_at_epoch_ms <= @pairingCutoff
        `)
        .run({ pairingCutoff }).changes;
      const pushSubscriptions = this.database
        .prepare(`
          DELETE FROM push_subscriptions
          WHERE revoked_at_epoch_ms IS NOT NULL
            AND revoked_at_epoch_ms <= @sessionCutoff
        `)
        .run({ sessionCutoff }).changes;
      const desktopSessions = this.database
        .prepare(`
          DELETE FROM desktop_sessions
          WHERE (
            revoked_at_epoch_ms IS NOT NULL
            AND revoked_at_epoch_ms <= @sessionCutoff
          )
          OR expires_at_epoch_ms <= @sessionCutoff
        `)
        .run({ sessionCutoff }).changes;
      const deviceSessions = this.database
        .prepare(`
          DELETE FROM device_sessions
          WHERE (
            revoked_at_epoch_ms IS NOT NULL
            AND revoked_at_epoch_ms <= @sessionCutoff
          )
          OR (
            created_at_epoch_ms + @deviceSessionTtlMs
              <= @sessionCutoff
          )
        `)
        .run({
          sessionCutoff,
          deviceSessionTtlMs: DEFAULT_DEVICE_SESSION_TTL_MS,
        }).changes;
      const pairingChallenges = this.database
        .prepare(`
          DELETE FROM pairing_challenges
          WHERE expires_at_epoch_ms <= @pairingCutoff
            AND NOT EXISTS (
              SELECT 1
              FROM device_sessions s
              WHERE s.pairing_challenge_id =
                pairing_challenges.challenge_id
            )
        `)
        .run({ pairingCutoff }).changes;
      return {
        notificationEvents,
        laundryWatches,
        laundryQueueEntries,
        laundryQueueClaims,
        pairingTransports,
        pushSubscriptions,
        desktopSessions,
        deviceSessions,
        pairingChallenges,
      };
    });
    return prune.immediate();
  }
}

function assertEpoch(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("Retention prune time is invalid.");
  }
}
