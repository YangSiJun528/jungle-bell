import type {
  NotificationRecord, PushDeliveryRecord, PushDeliveryResult, PushSubscriptionRecord,
} from "../workers/account-storage";

export type D1Value = string | number | null;

interface NotificationRow {
  id: string; user_id: string; source_event_id: string; kind: string; title: string; body: string; path: string;
  payload_json: string; created_at_epoch_ms: number; due_at_epoch_ms: number; expires_at_epoch_ms: number; desktop_attempt: number;
}
interface PushSubscriptionRow {
  id: string; user_id: string; session_id: string; endpoint: string; p256dh: string; auth: string;
  created_at_epoch_ms: number; revoked_at_epoch_ms: number | null;
}
interface PushDeliveryRow extends PushSubscriptionRow {
  notification_id: string; payload_json: string; expires_at_epoch_ms: number; attempts: number; lease_token: string;
}

export function notificationStatements(
  db: D1Database,
  value: NotificationRecord,
  guardSql = "1 = 1",
  guardValues: D1Value[] = [],
  returning = false,
): D1PreparedStatement[] {
  return [
    db.prepare(`INSERT OR IGNORE INTO notification (id, user_id, source_event_id, kind, title,
      body, path, payload_json, created_at_epoch_ms, due_at_epoch_ms, expires_at_epoch_ms)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guardSql}${returning ? " RETURNING id" : ""}`)
      .bind(value.id, value.userId, value.sourceEventId, value.kind, value.title, value.body, value.path,
        value.payloadJson, value.createdAtEpochMs, value.dueAtEpochMs, value.expiresAtEpochMs, ...guardValues),
  ];
}

export class D1NotificationRepository {
  constructor(private readonly db: D1Database) {}

  async insert(value: NotificationRecord): Promise<boolean> {
    // Remote D1 can report meta.changes=0 for INSERT ... SELECT when AFTER INSERT
    // fan-out triggers run. RETURNING is the only reliable inserted-vs-ignored signal.
    const inserted = await notificationStatements(this.db, value, "1 = 1", [], true)[0]!
      .first<{ id: string }>();
    return inserted?.id === value.id;
  }

  async listDesktopInbox(userId: string, installationId: string, now: number, limit: number): Promise<NotificationRecord[]> {
    const result = await this.db.prepare(`SELECT notification.*, delivery.attempts AS desktop_attempt
      FROM notification_delivery delivery JOIN notification ON notification.id = delivery.notification_id
      WHERE notification.user_id = ? AND delivery.target_kind = 'desktop' AND delivery.target_id = ?
      AND delivery.status IN ('pending', 'retry') AND delivery.next_attempt_at_epoch_ms <= ?
      AND notification.expires_at_epoch_ms > ? ORDER BY notification.due_at_epoch_ms, notification.id LIMIT ?`)
      .bind(userId, installationId, now, now, limit).all<NotificationRow>();
    if (result.results.length) {
      await this.db.batch(result.results.map((row) => this.db.prepare(`UPDATE notification_delivery
        SET status = 'retry', attempts = attempts + 1, next_attempt_at_epoch_ms = ?
        WHERE notification_id = ? AND target_kind = 'desktop' AND target_id = ? AND status IN ('pending', 'retry')`)
        .bind(now + 2 * 60_000, row.id, installationId)));
    }
    return result.results.map((row) => ({ ...notification(row), desktopAttempt: row.desktop_attempt + 1 }));
  }

  async listHistory(userId: string, limit: number): Promise<NotificationRecord[]> {
    const result = await this.db.prepare(`SELECT notification.*, 0 AS desktop_attempt FROM notification
      WHERE user_id = ? ORDER BY created_at_epoch_ms DESC LIMIT ?`).bind(userId, limit).all<NotificationRow>();
    return result.results.map((row) => ({ ...notification(row), desktopAttempt: Math.max(1, row.desktop_attempt) }));
  }

  async acknowledgeDesktop(userId: string, installationId: string, id: string, outcome: "displayed" | "failed", now: number): Promise<boolean> {
    const result = outcome === "displayed"
      ? await this.db.prepare(`UPDATE notification_delivery SET status = 'delivered', delivered_at_epoch_ms = ?,
          next_attempt_at_epoch_ms = NULL WHERE notification_id = ? AND target_kind = 'desktop' AND target_id = ?
          AND status IN ('pending', 'retry') AND EXISTS (SELECT 1 FROM notification WHERE id = ? AND user_id = ?)`)
          .bind(now, id, installationId, id, userId).run()
      : await this.db.prepare(`UPDATE notification_delivery SET status = 'retry', next_attempt_at_epoch_ms = ?,
          last_error = 'DESKTOP_DISPLAY_FAILED' WHERE notification_id = ? AND target_kind = 'desktop' AND target_id = ?
          AND status IN ('pending', 'retry') AND EXISTS (SELECT 1 FROM notification WHERE id = ? AND user_id = ?)`)
          .bind(now + 5_000, id, installationId, id, userId).run();
    return result.meta.changes === 1;
  }

  async upsertSubscription(value: PushSubscriptionRecord): Promise<void> {
    await this.db.batch([
      this.db.prepare(`UPDATE notification_delivery SET status = 'failed', next_attempt_at_epoch_ms = NULL,
        last_error = 'PUSH_SUBSCRIPTION_REASSIGNED', lease_token = NULL, lease_expires_at_epoch_ms = NULL
        WHERE target_kind = 'push' AND target_id = ? AND status IN ('pending', 'retry')
        AND EXISTS (SELECT 1 FROM push_subscription WHERE id = ? AND (user_id <> ? OR session_id <> ?))`)
        .bind(value.id, value.id, value.userId, value.sessionId),
      this.db.prepare(`INSERT INTO push_subscription (id, user_id, session_id, endpoint, p256dh, auth, created_at_epoch_ms, revoked_at_epoch_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL) ON CONFLICT(id) DO UPDATE SET user_id = excluded.user_id, session_id = excluded.session_id,
        endpoint = excluded.endpoint, p256dh = excluded.p256dh, auth = excluded.auth,
        created_at_epoch_ms = excluded.created_at_epoch_ms, revoked_at_epoch_ms = NULL`)
        .bind(value.id, value.userId, value.sessionId, value.endpoint, value.p256dh, value.auth, value.createdAtEpochMs),
    ]);
  }

  async revokeSubscription(userId: string, id: string, now: number): Promise<boolean> {
    const results = await this.db.batch([
      this.db.prepare("UPDATE push_subscription SET revoked_at_epoch_ms = ? WHERE id = ? AND user_id = ? AND revoked_at_epoch_ms IS NULL")
        .bind(now, id, userId),
      this.db.prepare(`UPDATE notification_delivery SET status = 'failed', next_attempt_at_epoch_ms = NULL,
        last_error = 'PUSH_SUBSCRIPTION_REVOKED', lease_token = NULL, lease_expires_at_epoch_ms = NULL
        WHERE target_kind = 'push' AND target_id = ?
        AND status IN ('pending', 'retry') AND EXISTS
          (SELECT 1 FROM push_subscription WHERE id = ? AND user_id = ? AND revoked_at_epoch_ms = ?)`)
        .bind(id, id, userId, now),
    ]);
    return results[0]?.meta.changes === 1;
  }

  async listActiveSubscriptions(userId: string, now: number): Promise<PushSubscriptionRecord[]> {
    const result = await this.db.prepare(`SELECT subscription.* FROM push_subscription subscription
      JOIN app_session session ON session.id = subscription.session_id
      WHERE subscription.user_id = ? AND subscription.revoked_at_epoch_ms IS NULL
      AND session.user_id = subscription.user_id AND session.kind = 'mobile'
      AND session.revoked_at_epoch_ms IS NULL AND session.expires_at_epoch_ms > ?`)
      .bind(userId, now).all<PushSubscriptionRow>();
    return result.results.map(pushSubscription);
  }

  async claimDuePushes(input: {
    nowEpochMs: number; limit: number; leaseToken: string; leaseExpiresAtEpochMs: number;
  }): Promise<PushDeliveryRecord[]> {
    const results = await this.db.batch<PushDeliveryRow>([
      this.db.prepare(`UPDATE notification_delivery SET status = 'failed', last_error = 'NOTIFICATION_EXPIRED',
        next_attempt_at_epoch_ms = NULL, lease_token = NULL, lease_expires_at_epoch_ms = NULL
        WHERE target_kind = 'push' AND status IN ('pending', 'retry') AND notification_id IN
        (SELECT id FROM notification WHERE expires_at_epoch_ms <= ?)`).bind(input.nowEpochMs),
      this.db.prepare(`UPDATE notification_delivery SET lease_token = ?, lease_expires_at_epoch_ms = ?
        WHERE rowid IN (SELECT delivery.rowid FROM notification_delivery delivery
          JOIN notification ON notification.id = delivery.notification_id
          JOIN push_subscription subscription ON subscription.id = delivery.target_id
          JOIN app_session session ON session.id = subscription.session_id
          WHERE delivery.target_kind = 'push' AND delivery.status IN ('pending', 'retry')
            AND delivery.next_attempt_at_epoch_ms <= ?
            AND (delivery.lease_token IS NULL OR delivery.lease_expires_at_epoch_ms <= ?)
            AND subscription.revoked_at_epoch_ms IS NULL AND notification.user_id = subscription.user_id
            AND session.kind = 'mobile' AND session.user_id = subscription.user_id
            AND session.revoked_at_epoch_ms IS NULL AND session.expires_at_epoch_ms > ?
            AND notification.expires_at_epoch_ms > ?
          ORDER BY delivery.next_attempt_at_epoch_ms, delivery.notification_id, delivery.target_id LIMIT ?)`)
        .bind(input.leaseToken, input.leaseExpiresAtEpochMs, input.nowEpochMs, input.nowEpochMs,
          input.nowEpochMs, input.nowEpochMs, input.limit),
      this.db.prepare(`SELECT delivery.notification_id, delivery.attempts, delivery.lease_token,
          notification.payload_json, notification.expires_at_epoch_ms, subscription.*
        FROM notification_delivery delivery JOIN notification ON notification.id = delivery.notification_id
        JOIN push_subscription subscription ON subscription.id = delivery.target_id
        WHERE delivery.target_kind = 'push' AND delivery.lease_token = ?
          AND delivery.lease_expires_at_epoch_ms = ?
        ORDER BY delivery.next_attempt_at_epoch_ms, delivery.notification_id, delivery.target_id`)
        .bind(input.leaseToken, input.leaseExpiresAtEpochMs),
    ]);
    return (results[2]?.results ?? []).map((row) => ({
      notificationId: row.notification_id, subscription: pushSubscription(row), payloadJson: row.payload_json,
      expiresAtEpochMs: row.expires_at_epoch_ms, attempts: row.attempts, leaseToken: row.lease_token,
    }));
  }

  async recordPushResults(inputs: readonly PushDeliveryResult[]): Promise<void> {
    if (inputs.length === 0) return;
    const encoded = JSON.stringify(inputs);
    await this.db.batch([
      this.db.prepare(`WITH result AS (
          SELECT json_extract(value, '$.notificationId') AS notification_id,
            json_extract(value, '$.subscriptionId') AS subscription_id,
            json_extract(value, '$.leaseToken') AS lease_token,
            json_extract(value, '$.nowEpochMs') AS now_epoch_ms
          FROM json_each(?) WHERE json_extract(value, '$.status') = 'gone'
        )
        UPDATE push_subscription AS subscription SET revoked_at_epoch_ms = (
          SELECT result.now_epoch_ms FROM result JOIN notification_delivery claimed
            ON claimed.notification_id = result.notification_id AND claimed.target_kind = 'push'
              AND claimed.target_id = result.subscription_id AND claimed.lease_token = result.lease_token
          WHERE result.subscription_id = subscription.id LIMIT 1)
        WHERE subscription.revoked_at_epoch_ms IS NULL AND EXISTS (
          SELECT 1 FROM result JOIN notification_delivery claimed
            ON claimed.notification_id = result.notification_id AND claimed.target_kind = 'push'
              AND claimed.target_id = result.subscription_id AND claimed.lease_token = result.lease_token
          WHERE result.subscription_id = subscription.id)`).bind(encoded),
      this.db.prepare(`WITH result AS (
          SELECT json_extract(value, '$.notificationId') AS notification_id,
            json_extract(value, '$.subscriptionId') AS subscription_id,
            json_extract(value, '$.leaseToken') AS lease_token,
            json_extract(value, '$.error') AS error
          FROM json_each(?) WHERE json_extract(value, '$.status') = 'gone'
        ), authorized AS MATERIALIZED (
          SELECT result.* FROM result JOIN notification_delivery claimed
            ON claimed.notification_id = result.notification_id AND claimed.target_kind = 'push'
              AND claimed.target_id = result.subscription_id AND claimed.lease_token = result.lease_token
        )
        UPDATE notification_delivery AS delivery SET
          status = CASE WHEN EXISTS (SELECT 1 FROM authorized exact
            WHERE exact.notification_id = delivery.notification_id
              AND exact.subscription_id = delivery.target_id) THEN 'gone' ELSE 'failed' END,
          attempts = attempts + CASE WHEN EXISTS (SELECT 1 FROM authorized exact
            WHERE exact.notification_id = delivery.notification_id
              AND exact.subscription_id = delivery.target_id) THEN 1 ELSE 0 END,
          next_attempt_at_epoch_ms = NULL,
          last_error = COALESCE((SELECT exact.error FROM authorized exact
            WHERE exact.notification_id = delivery.notification_id
              AND exact.subscription_id = delivery.target_id LIMIT 1), 'PUSH_SUBSCRIPTION_GONE'),
          lease_token = NULL, lease_expires_at_epoch_ms = NULL
        WHERE delivery.target_kind = 'push' AND delivery.status IN ('pending', 'retry')
          AND EXISTS (SELECT 1 FROM authorized WHERE authorized.subscription_id = delivery.target_id)`).bind(encoded),
      this.db.prepare(`WITH result AS (
          SELECT json_extract(value, '$.notificationId') AS notification_id,
            json_extract(value, '$.subscriptionId') AS subscription_id,
            json_extract(value, '$.leaseToken') AS lease_token,
            json_extract(value, '$.status') AS status,
            json_extract(value, '$.nowEpochMs') AS now_epoch_ms,
            json_extract(value, '$.nextAttemptAtEpochMs') AS next_attempt_at_epoch_ms,
            json_extract(value, '$.error') AS error
          FROM json_each(?) WHERE json_extract(value, '$.status') <> 'gone'
        )
        UPDATE notification_delivery AS delivery SET
          status = result.status, attempts = delivery.attempts + 1,
          next_attempt_at_epoch_ms = result.next_attempt_at_epoch_ms, last_error = result.error,
          delivered_at_epoch_ms = CASE WHEN result.status = 'delivered'
            THEN result.now_epoch_ms ELSE delivery.delivered_at_epoch_ms END,
          lease_token = NULL, lease_expires_at_epoch_ms = NULL
        FROM result WHERE delivery.notification_id = result.notification_id
          AND delivery.target_kind = 'push' AND delivery.target_id = result.subscription_id
          AND delivery.lease_token = result.lease_token`).bind(encoded),
    ]);
  }
}

function notification(row: NotificationRow): NotificationRecord {
  return {
    id: row.id, userId: row.user_id, sourceEventId: row.source_event_id, kind: row.kind, title: row.title,
    body: row.body, path: row.path, payloadJson: row.payload_json, createdAtEpochMs: row.created_at_epoch_ms,
    dueAtEpochMs: row.due_at_epoch_ms, expiresAtEpochMs: row.expires_at_epoch_ms, desktopAttempt: row.desktop_attempt,
  };
}
function pushSubscription(row: PushSubscriptionRow): PushSubscriptionRecord {
  return {
    id: row.id, userId: row.user_id, sessionId: row.session_id, endpoint: row.endpoint, p256dh: row.p256dh,
    auth: row.auth, createdAtEpochMs: row.created_at_epoch_ms, revokedAtEpochMs: row.revoked_at_epoch_ms,
  };
}
