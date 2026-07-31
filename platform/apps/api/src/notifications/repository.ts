import { randomUUID } from "node:crypto";

import type { SqliteDatabase } from "../infra/sqlite/database.js";
import {
  desktopNotificationAckSchema,
  notificationChannelSchema,
  notificationContentSchema,
  notificationKindSchema,
  type DesktopNotificationAck,
  type DesktopNotificationItem,
  type NotificationDelivery,
  type NotificationIntent,
  type NotificationTarget,
  type StoredNotificationEvent,
} from "./contracts.js";

export const NOTIFICATION_SQL_SCHEMA = `
  CREATE TABLE IF NOT EXISTS notification_events (
    id TEXT PRIMARY KEY CHECK (length(id) > 0),
    user_id TEXT NOT NULL CHECK (length(user_id) > 0),
    kind TEXT NOT NULL CHECK (
      kind IN (
        'meal-published',
        'laundry-finishing',
        'laundry-completed',
        'laundry-available',
        'laundry-attention',
        'attendance-action-required',
        'login-required'
      )
    ),
    source_event_id TEXT NOT NULL CHECK (length(source_event_id) BETWEEN 1 AND 512),
    dedupe_key TEXT NOT NULL CHECK (length(dedupe_key) BETWEEN 1 AND 200),
    title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 80),
    body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 240),
    path TEXT NOT NULL CHECK (
      length(path) BETWEEN 1 AND 512
      AND substr(path, 1, 1) = '/'
      AND substr(path, 1, 2) <> '//'
    ),
    metadata_json TEXT NOT NULL
      CHECK (json_valid(metadata_json) AND json_type(metadata_json) = 'object'),
    target_device_id TEXT,
    occurred_at_epoch_ms INTEGER NOT NULL CHECK (occurred_at_epoch_ms >= 0),
    expires_at_epoch_ms INTEGER NOT NULL
      CHECK (expires_at_epoch_ms > occurred_at_epoch_ms),
    created_at_epoch_ms INTEGER NOT NULL CHECK (created_at_epoch_ms >= 0),
    UNIQUE (user_id, dedupe_key)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS notification_events_user_created_idx
    ON notification_events (user_id, created_at_epoch_ms DESC, id);

  CREATE TABLE IF NOT EXISTS notification_outbox (
    event_id TEXT PRIMARY KEY
      REFERENCES notification_events(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (
      status IN ('pending', 'leased', 'retry', 'completed', 'failed')
    ),
    attempt_count INTEGER NOT NULL CHECK (attempt_count >= 0),
    available_at_epoch_ms INTEGER NOT NULL CHECK (available_at_epoch_ms >= 0),
    lease_until_epoch_ms INTEGER,
    completed_at_epoch_ms INTEGER,
    last_error_code TEXT,
    updated_at_epoch_ms INTEGER NOT NULL CHECK (updated_at_epoch_ms >= 0)
  ) STRICT, WITHOUT ROWID;

  CREATE INDEX IF NOT EXISTS notification_outbox_due_idx
    ON notification_outbox (status, available_at_epoch_ms, event_id);

  CREATE TABLE IF NOT EXISTS notification_deliveries (
    id TEXT PRIMARY KEY CHECK (length(id) > 0),
    event_id TEXT NOT NULL
      REFERENCES notification_events(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL CHECK (length(user_id) > 0),
    device_id TEXT NOT NULL CHECK (length(device_id) > 0),
    channel TEXT NOT NULL CHECK (channel IN ('web-push', 'desktop')),
    destination_id TEXT NOT NULL CHECK (length(destination_id) > 0),
    status TEXT NOT NULL CHECK (
      status IN (
        'pending',
        'leased',
        'awaiting_ack',
        'retry',
        'delivered',
        'failed',
        'cancelled'
      )
    ),
    attempt_count INTEGER NOT NULL CHECK (attempt_count >= 0),
    available_at_epoch_ms INTEGER NOT NULL CHECK (available_at_epoch_ms >= 0),
    lease_until_epoch_ms INTEGER,
    delivered_at_epoch_ms INTEGER,
    ack_outcome TEXT CHECK (
      ack_outcome IS NULL OR ack_outcome IN ('displayed', 'dismissed', 'failed')
    ),
    last_error_code TEXT,
    created_at_epoch_ms INTEGER NOT NULL CHECK (created_at_epoch_ms >= 0),
    updated_at_epoch_ms INTEGER NOT NULL CHECK (updated_at_epoch_ms >= 0),
    UNIQUE (event_id, device_id, channel, destination_id)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS notification_deliveries_due_idx
    ON notification_deliveries (
      channel,
      status,
      available_at_epoch_ms,
      id
    );

  CREATE INDEX IF NOT EXISTS notification_desktop_inbox_idx
    ON notification_deliveries (
      user_id,
      device_id,
      channel,
      status,
      available_at_epoch_ms,
      id
    );
`;

export interface ClaimedOutboxEvent {
  readonly event: StoredNotificationEvent;
  readonly attempt: number;
}

export interface NotificationRepository {
  enqueueIntent(
    intent: NotificationIntent,
    createdAtEpochMs: number,
  ): { readonly inserted: boolean; readonly eventId: string };
  claimOutbox(
    nowEpochMs: number,
    limit: number,
    leaseMs: number,
  ): ClaimedOutboxEvent[];
  completeOutbox(eventId: string, nowEpochMs: number): boolean;
  retryOutbox(
    eventId: string,
    nowEpochMs: number,
    availableAtEpochMs: number,
    errorCode: string,
    terminal: boolean,
  ): boolean;
  createDeliveries(
    event: StoredNotificationEvent,
    targets: readonly NotificationTarget[],
    nowEpochMs: number,
  ): number;
  claimWebPushDeliveries(
    nowEpochMs: number,
    limit: number,
    leaseMs: number,
  ): NotificationDelivery[];
  markDeliverySucceeded(
    deliveryId: string,
    nowEpochMs: number,
  ): boolean;
  retryDelivery(
    deliveryId: string,
    nowEpochMs: number,
    availableAtEpochMs: number,
    errorCode: string,
    terminal: boolean,
  ): boolean;
  claimDesktopInbox(
    userId: string,
    deviceId: string,
    nowEpochMs: number,
    limit: number,
    ackLeaseMs: number,
  ): DesktopNotificationItem[];
  acknowledgeDesktop(
    userId: string,
    deviceId: string,
    deliveryId: string,
    ack: DesktopNotificationAck,
    retryAtEpochMs: number,
  ): boolean;
  cancelDeviceDeliveries(
    userId: string,
    deviceId: string,
    channel: "desktop" | "web-push",
    nowEpochMs: number,
    errorCode: string,
  ): number;
}

export class SqliteNotificationRepository
  implements NotificationRepository
{
  constructor(private readonly database: SqliteDatabase) {}

  enqueueIntent(
    intent: NotificationIntent,
    createdAtEpochMs: number,
  ): { readonly inserted: boolean; readonly eventId: string } {
    validateIntent(intent);
    assertEpoch(createdAtEpochMs, "createdAtEpochMs");
    const eventId = randomUUID();
    const insert = this.database.transaction(() => {
      const result = this.database
        .prepare(`
          INSERT OR IGNORE INTO notification_events (
            id,
            user_id,
            kind,
            source_event_id,
            dedupe_key,
            title,
            body,
            path,
            metadata_json,
            target_device_id,
            occurred_at_epoch_ms,
            expires_at_epoch_ms,
            created_at_epoch_ms
          ) VALUES (
            @id,
            @userId,
            @kind,
            @sourceEventId,
            @dedupeKey,
            @title,
            @body,
            @path,
            @metadataJson,
            @targetDeviceId,
            @occurredAtEpochMs,
            @expiresAtEpochMs,
            @createdAtEpochMs
          )
        `)
        .run({
          id: eventId,
          userId: intent.userId,
          kind: intent.kind,
          sourceEventId: intent.sourceEventId,
          dedupeKey: intent.dedupeKey,
          title: intent.content.title,
          body: intent.content.body,
          path: intent.content.path,
          metadataJson: JSON.stringify(intent.metadata),
          targetDeviceId: intent.targetDeviceId,
          occurredAtEpochMs: intent.occurredAtEpochMs,
          expiresAtEpochMs: intent.expiresAtEpochMs,
          createdAtEpochMs,
        });
      if (result.changes === 1) {
        this.database
          .prepare(`
            INSERT INTO notification_outbox (
              event_id,
              status,
              attempt_count,
              available_at_epoch_ms,
              lease_until_epoch_ms,
              completed_at_epoch_ms,
              last_error_code,
              updated_at_epoch_ms
            ) VALUES (
              @eventId, 'pending', 0, @createdAtEpochMs,
              NULL, NULL, NULL, @createdAtEpochMs
            )
          `)
          .run({ eventId, createdAtEpochMs });
        return { inserted: true, eventId };
      }
      const existing = this.database
        .prepare(`
          SELECT id
          FROM notification_events
          WHERE user_id = ? AND dedupe_key = ?
        `)
        .get(intent.userId, intent.dedupeKey);
      return {
        inserted: false,
        eventId: readText(asRow(existing), "id"),
      };
    });
    return insert.immediate();
  }

  claimOutbox(
    nowEpochMs: number,
    limit: number,
    leaseMs: number,
  ): ClaimedOutboxEvent[] {
    validateClaim(nowEpochMs, limit, leaseMs);
    const claim = this.database.transaction(() => {
      this.database
        .prepare(`
          UPDATE notification_outbox
          SET
            status = 'completed',
            lease_until_epoch_ms = NULL,
            completed_at_epoch_ms = @nowEpochMs,
            last_error_code = 'EVENT_EXPIRED',
            updated_at_epoch_ms = @nowEpochMs
          WHERE event_id IN (
            SELECT id
            FROM notification_events
            WHERE expires_at_epoch_ms <= @nowEpochMs
          )
            AND status IN ('pending', 'leased', 'retry')
        `)
        .run({ nowEpochMs });
      this.database
        .prepare(`
          UPDATE notification_outbox
          SET
            status = 'retry',
            available_at_epoch_ms = @nowEpochMs,
            lease_until_epoch_ms = NULL,
            last_error_code = 'LEASE_EXPIRED',
            updated_at_epoch_ms = @nowEpochMs
          WHERE status = 'leased'
            AND lease_until_epoch_ms <= @nowEpochMs
        `)
        .run({ nowEpochMs });
      const rows = this.database
        .prepare(`
          SELECT ${EVENT_COLUMNS}
          FROM notification_outbox o
          JOIN notification_events e ON e.id = o.event_id
          WHERE o.status IN ('pending', 'retry')
            AND o.available_at_epoch_ms <= @nowEpochMs
          ORDER BY o.available_at_epoch_ms, o.event_id
          LIMIT @limit
        `)
        .all({ nowEpochMs, limit });
      const claimed: ClaimedOutboxEvent[] = [];
      for (const value of rows) {
        const row = asRow(value);
        const eventId = readText(row, "event_id");
        const updated = this.database
          .prepare(`
            UPDATE notification_outbox
            SET
              status = 'leased',
              attempt_count = attempt_count + 1,
              lease_until_epoch_ms = @leaseUntilEpochMs,
              updated_at_epoch_ms = @nowEpochMs
            WHERE event_id = @eventId
              AND status IN ('pending', 'retry')
              AND available_at_epoch_ms <= @nowEpochMs
          `)
          .run({
            eventId,
            nowEpochMs,
            leaseUntilEpochMs: nowEpochMs + leaseMs,
          });
        if (updated.changes === 1) {
          claimed.push({
            event: mapStoredEvent(row),
            attempt: integer(row, "outbox_attempt_count") + 1,
          });
        }
      }
      return claimed;
    });
    return claim.immediate();
  }

  completeOutbox(eventId: string, nowEpochMs: number): boolean {
    assertId(eventId, "eventId");
    assertEpoch(nowEpochMs, "nowEpochMs");
    const result = this.database
      .prepare(`
        UPDATE notification_outbox
        SET
          status = 'completed',
          lease_until_epoch_ms = NULL,
          completed_at_epoch_ms = @nowEpochMs,
          last_error_code = NULL,
          updated_at_epoch_ms = @nowEpochMs
        WHERE event_id = @eventId AND status = 'leased'
      `)
      .run({ eventId, nowEpochMs });
    return result.changes === 1;
  }

  retryOutbox(
    eventId: string,
    nowEpochMs: number,
    availableAtEpochMs: number,
    errorCode: string,
    terminal: boolean,
  ): boolean {
    return this.transitionFailure(
      "notification_outbox",
      "event_id",
      eventId,
      nowEpochMs,
      availableAtEpochMs,
      errorCode,
      terminal,
    );
  }

  createDeliveries(
    event: StoredNotificationEvent,
    targets: readonly NotificationTarget[],
    nowEpochMs: number,
  ): number {
    assertEpoch(nowEpochMs, "nowEpochMs");
    if (event.intent.expiresAtEpochMs <= nowEpochMs) {
      return 0;
    }
    const insert = this.database.transaction(() => {
      let count = 0;
      for (const target of targets) {
        validateTarget(target);
        if (
          !target.enabled ||
          target.userId !== event.intent.userId ||
          (event.intent.targetDeviceId !== null &&
            target.deviceId !== event.intent.targetDeviceId)
        ) {
          continue;
        }
        const result = this.database
          .prepare(`
            INSERT OR IGNORE INTO notification_deliveries (
              id,
              event_id,
              user_id,
              device_id,
              channel,
              destination_id,
              status,
              attempt_count,
              available_at_epoch_ms,
              lease_until_epoch_ms,
              delivered_at_epoch_ms,
              ack_outcome,
              last_error_code,
              created_at_epoch_ms,
              updated_at_epoch_ms
            ) VALUES (
              @id,
              @eventId,
              @userId,
              @deviceId,
              @channel,
              @destinationId,
              'pending',
              0,
              @nowEpochMs,
              NULL,
              NULL,
              NULL,
              NULL,
              @nowEpochMs,
              @nowEpochMs
            )
          `)
          .run({
            id: randomUUID(),
            eventId: event.id,
            userId: target.userId,
            deviceId: target.deviceId,
            channel: target.channel,
            destinationId: target.destinationId,
            nowEpochMs,
          });
        count += result.changes;
      }
      return count;
    });
    return insert.immediate();
  }

  claimWebPushDeliveries(
    nowEpochMs: number,
    limit: number,
    leaseMs: number,
  ): NotificationDelivery[] {
    validateClaim(nowEpochMs, limit, leaseMs);
    const claim = this.database.transaction(() => {
      cancelExpiredDeliveries(this.database, nowEpochMs);
      requeueExpiredDeliveryLeases(this.database, nowEpochMs);
      const rows = this.database
        .prepare(`
          SELECT ${DELIVERY_EVENT_COLUMNS}
          FROM notification_deliveries d
          JOIN notification_events e ON e.id = d.event_id
          WHERE d.channel = 'web-push'
            AND d.status IN ('pending', 'retry')
            AND d.available_at_epoch_ms <= @nowEpochMs
          ORDER BY d.available_at_epoch_ms, d.id
          LIMIT @limit
        `)
        .all({ nowEpochMs, limit });
      const deliveries: NotificationDelivery[] = [];
      for (const value of rows) {
        const row = asRow(value);
        const deliveryId = readText(row, "delivery_id");
        const updated = this.database
          .prepare(`
            UPDATE notification_deliveries
            SET
              status = 'leased',
              attempt_count = attempt_count + 1,
              lease_until_epoch_ms = @leaseUntilEpochMs,
              updated_at_epoch_ms = @nowEpochMs
            WHERE id = @deliveryId
              AND status IN ('pending', 'retry')
              AND available_at_epoch_ms <= @nowEpochMs
          `)
          .run({
            deliveryId,
            nowEpochMs,
            leaseUntilEpochMs: nowEpochMs + leaseMs,
          });
        if (updated.changes === 1) {
          deliveries.push(
            mapDelivery(row, {
              status: "leased",
              attempt: integer(row, "delivery_attempt_count") + 1,
              leaseUntilEpochMs: nowEpochMs + leaseMs,
            }),
          );
        }
      }
      return deliveries;
    });
    return claim.immediate();
  }

  markDeliverySucceeded(
    deliveryId: string,
    nowEpochMs: number,
  ): boolean {
    assertId(deliveryId, "deliveryId");
    assertEpoch(nowEpochMs, "nowEpochMs");
    const result = this.database
      .prepare(`
        UPDATE notification_deliveries
        SET
          status = 'delivered',
          lease_until_epoch_ms = NULL,
          delivered_at_epoch_ms = @nowEpochMs,
          last_error_code = NULL,
          updated_at_epoch_ms = @nowEpochMs
        WHERE id = @deliveryId AND status = 'leased'
      `)
      .run({ deliveryId, nowEpochMs });
    return result.changes === 1;
  }

  retryDelivery(
    deliveryId: string,
    nowEpochMs: number,
    availableAtEpochMs: number,
    errorCode: string,
    terminal: boolean,
  ): boolean {
    return this.transitionFailure(
      "notification_deliveries",
      "id",
      deliveryId,
      nowEpochMs,
      availableAtEpochMs,
      errorCode,
      terminal,
    );
  }

  claimDesktopInbox(
    userId: string,
    deviceId: string,
    nowEpochMs: number,
    limit: number,
    ackLeaseMs: number,
  ): DesktopNotificationItem[] {
    assertId(userId, "userId");
    assertId(deviceId, "deviceId");
    validateClaim(nowEpochMs, limit, ackLeaseMs);
    const claim = this.database.transaction(() => {
      cancelExpiredDeliveries(this.database, nowEpochMs);
      this.database
        .prepare(`
          UPDATE notification_deliveries
          SET
            status = CASE
              WHEN attempt_count >= 8 THEN 'failed'
              ELSE 'retry'
            END,
            available_at_epoch_ms = @nowEpochMs,
            lease_until_epoch_ms = NULL,
            last_error_code = 'ACK_TIMEOUT',
            updated_at_epoch_ms = @nowEpochMs
          WHERE channel = 'desktop'
            AND user_id = @userId
            AND device_id = @deviceId
            AND status = 'awaiting_ack'
            AND lease_until_epoch_ms <= @nowEpochMs
        `)
        .run({ userId, deviceId, nowEpochMs });
      const rows = this.database
        .prepare(`
          SELECT ${DELIVERY_EVENT_COLUMNS}
          FROM notification_deliveries d
          JOIN notification_events e ON e.id = d.event_id
          WHERE d.channel = 'desktop'
            AND d.user_id = @userId
            AND d.device_id = @deviceId
            AND d.status IN ('pending', 'retry')
            AND d.available_at_epoch_ms <= @nowEpochMs
          ORDER BY d.available_at_epoch_ms, d.id
          LIMIT @limit
        `)
        .all({ userId, deviceId, nowEpochMs, limit });
      const items: DesktopNotificationItem[] = [];
      for (const value of rows) {
        const row = asRow(value);
        const deliveryId = readText(row, "delivery_id");
        const updated = this.database
          .prepare(`
            UPDATE notification_deliveries
            SET
              status = 'awaiting_ack',
              attempt_count = attempt_count + 1,
              lease_until_epoch_ms = @leaseUntilEpochMs,
              updated_at_epoch_ms = @nowEpochMs
            WHERE id = @deliveryId
              AND status IN ('pending', 'retry')
              AND available_at_epoch_ms <= @nowEpochMs
          `)
          .run({
            deliveryId,
            nowEpochMs,
            leaseUntilEpochMs: nowEpochMs + ackLeaseMs,
          });
        if (updated.changes === 1) {
          const event = mapStoredEvent(row);
          items.push({
            deliveryId,
            eventId: event.id,
            kind: event.intent.kind,
            title: event.intent.content.title,
            body: event.intent.content.body,
            path: event.intent.content.path,
            createdAtEpochMs: event.createdAtEpochMs,
            attempt: integer(row, "delivery_attempt_count") + 1,
          });
        }
      }
      return items;
    });
    return claim.immediate();
  }

  acknowledgeDesktop(
    userId: string,
    deviceId: string,
    deliveryId: string,
    ack: DesktopNotificationAck,
    retryAtEpochMs: number,
  ): boolean {
    assertId(userId, "userId");
    assertId(deviceId, "deviceId");
    assertId(deliveryId, "deliveryId");
    desktopNotificationAckSchema.parse(ack);
    assertEpoch(retryAtEpochMs, "retryAtEpochMs");
    if (retryAtEpochMs < ack.occurredAtEpochMs) {
      throw new TypeError("retryAtEpochMs cannot precede acknowledgement.");
    }
    const success = ack.outcome !== "failed";
    const result = this.database
      .prepare(`
        UPDATE notification_deliveries
        SET
          status = CASE
            WHEN @failed = 0 THEN 'delivered'
            WHEN attempt_count >= 8 THEN 'failed'
            ELSE 'retry'
          END,
          available_at_epoch_ms = @availableAtEpochMs,
          lease_until_epoch_ms = NULL,
          delivered_at_epoch_ms = @deliveredAtEpochMs,
          ack_outcome = @outcome,
          last_error_code = @lastErrorCode,
          updated_at_epoch_ms = @occurredAtEpochMs
        WHERE id = @deliveryId
          AND user_id = @userId
          AND device_id = @deviceId
          AND channel = 'desktop'
          AND status = 'awaiting_ack'
          AND created_at_epoch_ms <= @occurredAtEpochMs
      `)
      .run({
        userId,
        deviceId,
        deliveryId,
        failed: success ? 0 : 1,
        availableAtEpochMs: success
          ? ack.occurredAtEpochMs
          : retryAtEpochMs,
        deliveredAtEpochMs: success ? ack.occurredAtEpochMs : null,
        outcome: ack.outcome,
        lastErrorCode: success ? null : "DESKTOP_DISPLAY_FAILED",
        occurredAtEpochMs: ack.occurredAtEpochMs,
      });
    return result.changes === 1;
  }

  cancelDeviceDeliveries(
    userId: string,
    deviceId: string,
    channel: "desktop" | "web-push",
    nowEpochMs: number,
    errorCode: string,
  ): number {
    assertId(userId, "userId");
    assertId(deviceId, "deviceId");
    notificationChannelSchema.parse(channel);
    assertEpoch(nowEpochMs, "nowEpochMs");
    if (errorCode.length < 1 || errorCode.length > 128) {
      throw new TypeError("Cancellation error code is invalid.");
    }
    const result = this.database
      .prepare(`
        UPDATE notification_deliveries
        SET
          status = 'cancelled',
          lease_until_epoch_ms = NULL,
          last_error_code = @errorCode,
          updated_at_epoch_ms = @nowEpochMs
        WHERE user_id = @userId
          AND device_id = @deviceId
          AND channel = @channel
          AND status IN ('pending', 'leased', 'retry', 'awaiting_ack')
      `)
      .run({
        userId,
        deviceId,
        channel,
        nowEpochMs,
        errorCode,
      });
    return result.changes;
  }

  private transitionFailure(
    table: "notification_outbox" | "notification_deliveries",
    idColumn: "event_id" | "id",
    id: string,
    nowEpochMs: number,
    availableAtEpochMs: number,
    errorCode: string,
    terminal: boolean,
  ): boolean {
    assertId(id, "id");
    assertEpoch(nowEpochMs, "nowEpochMs");
    assertEpoch(availableAtEpochMs, "availableAtEpochMs");
    if (
      availableAtEpochMs < nowEpochMs ||
      errorCode.length < 1 ||
      errorCode.length > 128
    ) {
      throw new TypeError("Failure transition is invalid.");
    }
    const result = this.database
      .prepare(`
        UPDATE ${table}
        SET
          status = @status,
          available_at_epoch_ms = @availableAtEpochMs,
          lease_until_epoch_ms = NULL,
          last_error_code = @errorCode,
          updated_at_epoch_ms = @nowEpochMs
        WHERE ${idColumn} = @id AND status = 'leased'
      `)
      .run({
        id,
        status: terminal ? "failed" : "retry",
        nowEpochMs,
        availableAtEpochMs,
        errorCode,
      });
    return result.changes === 1;
  }
}

const EVENT_COLUMNS = `
  e.id AS event_id,
  e.user_id AS event_user_id,
  e.kind AS event_kind,
  e.source_event_id,
  e.dedupe_key,
  e.title,
  e.body,
  e.path,
  e.metadata_json,
  e.target_device_id,
  e.occurred_at_epoch_ms,
  e.expires_at_epoch_ms,
  e.created_at_epoch_ms AS event_created_at_epoch_ms,
  o.attempt_count AS outbox_attempt_count
`;

const DELIVERY_EVENT_COLUMNS = `
  d.id AS delivery_id,
  d.event_id,
  d.user_id AS delivery_user_id,
  d.device_id,
  d.channel,
  d.destination_id,
  d.status AS delivery_status,
  d.attempt_count AS delivery_attempt_count,
  d.available_at_epoch_ms,
  d.lease_until_epoch_ms,
  e.user_id AS event_user_id,
  e.kind AS event_kind,
  e.source_event_id,
  e.dedupe_key,
  e.title,
  e.body,
  e.path,
  e.metadata_json,
  e.target_device_id,
  e.occurred_at_epoch_ms,
  e.expires_at_epoch_ms,
  e.created_at_epoch_ms AS event_created_at_epoch_ms
`;

function mapStoredEvent(row: Record<string, unknown>): StoredNotificationEvent {
  const metadata = JSON.parse(readText(row, "metadata_json")) as unknown;
  if (
    typeof metadata !== "object" ||
    metadata === null ||
    Array.isArray(metadata)
  ) {
    throw new TypeError("Notification metadata is invalid.");
  }
  const intent: NotificationIntent = {
    userId: readText(row, "event_user_id"),
    kind: notificationKindSchema.parse(row.event_kind),
    sourceEventId: readText(row, "source_event_id"),
    dedupeKey: readText(row, "dedupe_key"),
    content: notificationContentSchema.parse({
      title: row.title,
      body: row.body,
      path: row.path,
    }),
    metadata: metadata as Record<string, unknown>,
    targetDeviceId: nullableText(row, "target_device_id"),
    occurredAtEpochMs: integer(row, "occurred_at_epoch_ms"),
    expiresAtEpochMs: integer(row, "expires_at_epoch_ms"),
  };
  validateIntent(intent);
  return {
    id: readText(row, "event_id"),
    intent,
    createdAtEpochMs: integer(row, "event_created_at_epoch_ms"),
  };
}

function mapDelivery(
  row: Record<string, unknown>,
  override?: {
    readonly status: NotificationDelivery["status"];
    readonly attempt: number;
    readonly leaseUntilEpochMs: number | null;
  },
): NotificationDelivery {
  const status =
    override?.status ?? deliveryStatus(row.delivery_status);
  return {
    id: readText(row, "delivery_id"),
    eventId: readText(row, "event_id"),
    userId: readText(row, "delivery_user_id"),
    deviceId: readText(row, "device_id"),
    channel: notificationChannelSchema.parse(row.channel),
    destinationId: readText(row, "destination_id"),
    status,
    attempt:
      override?.attempt ?? integer(row, "delivery_attempt_count"),
    availableAtEpochMs: integer(row, "available_at_epoch_ms"),
    leaseUntilEpochMs:
      override?.leaseUntilEpochMs ??
      nullableInteger(row, "lease_until_epoch_ms"),
    event: mapStoredEvent(row),
  };
}

function requeueExpiredDeliveryLeases(
  database: SqliteDatabase,
  nowEpochMs: number,
): void {
  database
    .prepare(`
      UPDATE notification_deliveries
      SET
        status = 'retry',
        available_at_epoch_ms = @nowEpochMs,
        lease_until_epoch_ms = NULL,
        last_error_code = 'LEASE_EXPIRED',
        updated_at_epoch_ms = @nowEpochMs
      WHERE status = 'leased'
        AND lease_until_epoch_ms <= @nowEpochMs
    `)
    .run({ nowEpochMs });
}

function cancelExpiredDeliveries(
  database: SqliteDatabase,
  nowEpochMs: number,
): void {
  database
    .prepare(`
      UPDATE notification_deliveries
      SET
        status = 'cancelled',
        lease_until_epoch_ms = NULL,
        last_error_code = 'EVENT_EXPIRED',
        updated_at_epoch_ms = @nowEpochMs
      WHERE event_id IN (
        SELECT id
        FROM notification_events
        WHERE expires_at_epoch_ms <= @nowEpochMs
      )
        AND status IN ('pending', 'leased', 'retry', 'awaiting_ack')
    `)
    .run({ nowEpochMs });
}

function validateIntent(intent: NotificationIntent): void {
  assertId(intent.userId, "userId");
  notificationKindSchema.parse(intent.kind);
  notificationContentSchema.parse(intent.content);
  assertId(intent.sourceEventId, "sourceEventId", 512);
  if (
    intent.dedupeKey.length < 1 ||
    intent.dedupeKey.length > 200 ||
    !/^[A-Za-z0-9:_-]+$/u.test(intent.dedupeKey) ||
    (intent.targetDeviceId !== null &&
      intent.targetDeviceId.length < 1) ||
    typeof intent.metadata !== "object" ||
    intent.metadata === null ||
    Array.isArray(intent.metadata)
  ) {
    throw new TypeError("Notification intent is invalid.");
  }
  assertEpoch(intent.occurredAtEpochMs, "occurredAtEpochMs");
  assertEpoch(intent.expiresAtEpochMs, "expiresAtEpochMs");
  if (intent.expiresAtEpochMs <= intent.occurredAtEpochMs) {
    throw new TypeError(
      "Notification expiry must follow occurrence time.",
    );
  }
}

function validateTarget(target: NotificationTarget): void {
  assertId(target.userId, "target.userId");
  assertId(target.deviceId, "target.deviceId");
  assertId(target.destinationId, "target.destinationId", 2_048);
  notificationChannelSchema.parse(target.channel);
}

function validateClaim(
  nowEpochMs: number,
  limit: number,
  leaseMs: number,
): void {
  assertEpoch(nowEpochMs, "nowEpochMs");
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 500 ||
    !Number.isSafeInteger(leaseMs) ||
    leaseMs < 1
  ) {
    throw new TypeError("Claim parameters are invalid.");
  }
}

function deliveryStatus(
  value: unknown,
): NotificationDelivery["status"] {
  if (
    value !== "pending" &&
    value !== "leased" &&
    value !== "awaiting_ack" &&
    value !== "retry" &&
    value !== "delivered" &&
    value !== "failed" &&
    value !== "cancelled"
  ) {
    throw new TypeError("Delivery status is invalid.");
  }
  return value;
}

function asRow(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("SQLite row was invalid.");
  }
  return value as Record<string, unknown>;
}

function readText(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${key} must be non-empty text.`);
  }
  return value;
}

function nullableText(
  row: Record<string, unknown>,
  key: string,
): string | null {
  return row[key] === null ? null : readText(row, key);
}

function integer(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new TypeError(`${key} must be a non-negative safe integer.`);
  }
  return value;
}

function nullableInteger(
  row: Record<string, unknown>,
  key: string,
): number | null {
  return row[key] === null ? null : integer(row, key);
}

function assertId(
  value: string,
  name: string,
  maxLength = 256,
): void {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maxLength
  ) {
    throw new TypeError(`${name} is invalid.`);
  }
}

function assertEpoch(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer.`);
  }
}
