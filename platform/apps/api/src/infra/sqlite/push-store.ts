import {
  parsePushSubscription,
  type PushDedupeStore,
  type PushSubscriptionRecord,
  type PushSubscriptionRevocationReason,
  type PushSubscriptionStore,
  type RevokePushSubscriptionInput,
} from "../../push/index.js";
import {
  expectRow,
  readInteger,
  readNullableInteger,
  readNullableText,
  readText,
  isSqliteUniquenessError,
  SqliteDataIntegrityError,
} from "./codec.js";
import type { SqliteDatabase } from "./database.js";

const SUBSCRIPTION_COLUMNS = `
  id,
  user_id,
  device_id,
  endpoint,
  expiration_time,
  auth_key,
  p256dh_key,
  created_at_epoch_ms,
  updated_at_epoch_ms,
  revoked_at_epoch_ms,
  revoked_reason
`;

const SUBSCRIPTION_KEYS = [
  "id",
  "user_id",
  "device_id",
  "endpoint",
  "expiration_time",
  "auth_key",
  "p256dh_key",
  "created_at_epoch_ms",
  "updated_at_epoch_ms",
  "revoked_at_epoch_ms",
  "revoked_reason",
] as const;

const REVOCATION_REASONS =
  new Set<PushSubscriptionRevocationReason>([
    "push-endpoint-gone",
    "user-unsubscribed",
    "device-revoked",
    "replaced",
  ]);

export class SqlitePushSubscriptionStore
  implements PushSubscriptionStore
{
  constructor(private readonly database: SqliteDatabase) {}

  async upsert(record: PushSubscriptionRecord): Promise<boolean> {
    validateRecord(record);
    try {
      const result = this.database
        .prepare(`
        INSERT INTO push_subscriptions (
          ${SUBSCRIPTION_COLUMNS}
        ) VALUES (
          @id,
          @userId,
          @deviceId,
          @endpoint,
          @expirationTime,
          @authKey,
          @p256dhKey,
          @createdAtEpochMs,
          @updatedAtEpochMs,
          @revokedAtEpochMs,
          @revokedReason
        )
        ON CONFLICT(id) DO UPDATE SET
          user_id = excluded.user_id,
          device_id = excluded.device_id,
          endpoint = excluded.endpoint,
          expiration_time = excluded.expiration_time,
          auth_key = excluded.auth_key,
          p256dh_key = excluded.p256dh_key,
          created_at_epoch_ms = CASE
            WHEN push_subscriptions.user_id <> excluded.user_id
              OR push_subscriptions.device_id <> excluded.device_id
            THEN excluded.created_at_epoch_ms
            ELSE push_subscriptions.created_at_epoch_ms
          END,
          updated_at_epoch_ms = excluded.updated_at_epoch_ms,
          revoked_at_epoch_ms = excluded.revoked_at_epoch_ms,
          revoked_reason = excluded.revoked_reason
        WHERE (
            push_subscriptions.user_id = excluded.user_id
            AND push_subscriptions.device_id = excluded.device_id
          )
          OR push_subscriptions.revoked_reason = 'device-revoked'
      `)
        .run({
          id: record.id,
          userId: record.userId,
          deviceId: record.deviceId,
          endpoint: record.subscription.endpoint,
          expirationTime: record.subscription.expirationTime,
          authKey: record.subscription.keys.auth,
          p256dhKey: record.subscription.keys.p256dh,
          createdAtEpochMs: record.createdAtEpochMs,
          updatedAtEpochMs: record.updatedAtEpochMs,
          revokedAtEpochMs: record.revokedAtEpochMs,
          revokedReason: record.revokedReason,
        });
      return result.changes === 1;
    } catch (error) {
      if (isSqliteUniquenessError(error)) {
        return false;
      }
      throw error;
    }
  }

  async findById(
    id: string,
  ): Promise<PushSubscriptionRecord | undefined> {
    const row = this.database
      .prepare(
        `SELECT ${SUBSCRIPTION_COLUMNS} FROM push_subscriptions WHERE id = ?`,
      )
      .get(id);
    return row === undefined ? undefined : mapRecord(row);
  }

  async findActiveById(
    id: string,
  ): Promise<PushSubscriptionRecord | undefined> {
    const row = this.database
      .prepare(`
        SELECT ${SUBSCRIPTION_COLUMNS}
        FROM push_subscriptions
        WHERE id = ? AND revoked_at_epoch_ms IS NULL
      `)
      .get(id);
    return row === undefined ? undefined : mapRecord(row);
  }

  async listActiveByUserId(
    userId: string,
  ): Promise<PushSubscriptionRecord[]> {
    return this.database
      .prepare(`
        SELECT ${SUBSCRIPTION_COLUMNS}
        FROM push_subscriptions
        WHERE user_id = ? AND revoked_at_epoch_ms IS NULL
        ORDER BY updated_at_epoch_ms DESC, id
      `)
      .all(userId)
      .map(mapRecord);
  }

  async revoke(
    id: string,
    input: RevokePushSubscriptionInput,
  ): Promise<boolean> {
    if (
      !Number.isSafeInteger(input.atEpochMs) ||
      input.atEpochMs < 0 ||
      !REVOCATION_REASONS.has(input.reason)
    ) {
      throw new SqliteDataIntegrityError(
        "Push subscription revocation is invalid.",
      );
    }
    const result = this.database
      .prepare(`
        UPDATE push_subscriptions
        SET
          updated_at_epoch_ms = @atEpochMs,
          revoked_at_epoch_ms = @atEpochMs,
          revoked_reason = @reason
        WHERE id = @id
          AND revoked_at_epoch_ms IS NULL
          AND created_at_epoch_ms <= @atEpochMs
      `)
      .run({ id, ...input });
    return result.changes === 1;
  }
}

export class SqlitePushDedupeStore implements PushDedupeStore {
  private readonly pendingLeaseMs: number;

  constructor(
    private readonly database: SqliteDatabase,
    private readonly retentionMs: number,
    pendingLeaseMs = Math.min(retentionMs, 2 * 60 * 1_000),
  ) {
    if (
      !Number.isSafeInteger(retentionMs) ||
      retentionMs <= 0 ||
      !Number.isSafeInteger(pendingLeaseMs) ||
      pendingLeaseMs <= 0 ||
      pendingLeaseMs > retentionMs
    ) {
      throw new TypeError(
        "Push dedupe retention and pending lease must be positive safe integers.",
      );
    }
    this.pendingLeaseMs = pendingLeaseMs;
  }

  async tryStart(
    dedupeKey: string,
    nowEpochMs: number,
  ): Promise<boolean> {
    validateDedupeInput(dedupeKey, nowEpochMs);
    this.database
      .prepare(
        "DELETE FROM push_delivery_dedupe WHERE expires_at_epoch_ms <= ?",
      )
      .run(nowEpochMs);
    const result = this.database
      .prepare(`
        INSERT INTO push_delivery_dedupe (
          dedupe_key,
          state,
          expires_at_epoch_ms
        ) VALUES (
          @dedupeKey,
          'pending',
          @expiresAtEpochMs
        )
        ON CONFLICT(dedupe_key) DO UPDATE SET
          state = 'pending',
          expires_at_epoch_ms = excluded.expires_at_epoch_ms
        WHERE push_delivery_dedupe.expires_at_epoch_ms <= @nowEpochMs
      `)
      .run({
        dedupeKey,
        nowEpochMs,
        expiresAtEpochMs: nowEpochMs + this.pendingLeaseMs,
      });
    return result.changes === 1;
  }

  async complete(
    dedupeKey: string,
    nowEpochMs: number,
  ): Promise<void> {
    validateDedupeInput(dedupeKey, nowEpochMs);
    this.database
      .prepare(`
        INSERT INTO push_delivery_dedupe (
          dedupe_key,
          state,
          expires_at_epoch_ms
        ) VALUES (
          @dedupeKey,
          'completed',
          @expiresAtEpochMs
        )
        ON CONFLICT(dedupe_key) DO UPDATE SET
          state = 'completed',
          expires_at_epoch_ms = excluded.expires_at_epoch_ms
      `)
      .run({
        dedupeKey,
        expiresAtEpochMs: nowEpochMs + this.retentionMs,
      });
  }

  async release(dedupeKey: string): Promise<void> {
    this.database
      .prepare(
        "DELETE FROM push_delivery_dedupe WHERE dedupe_key = ? AND state = 'pending'",
      )
      .run(dedupeKey);
  }
}

function mapRecord(value: unknown): PushSubscriptionRecord {
  const row = expectRow(value, SUBSCRIPTION_KEYS, "push subscription");
  const revokedReason = readNullableText(row, "revoked_reason");
  if (
    revokedReason !== null &&
    !REVOCATION_REASONS.has(
      revokedReason as PushSubscriptionRevocationReason,
    )
  ) {
    throw new SqliteDataIntegrityError(
      "Push subscription has an invalid revocation reason.",
    );
  }
  const record: PushSubscriptionRecord = {
    id: readText(row, "id"),
    userId: readText(row, "user_id"),
    deviceId: readText(row, "device_id"),
    subscription: parsePushSubscription({
      endpoint: readText(row, "endpoint"),
      expirationTime: readNullableInteger(row, "expiration_time"),
      keys: {
        auth: readText(row, "auth_key"),
        p256dh: readText(row, "p256dh_key"),
      },
    }),
    createdAtEpochMs: readInteger(row, "created_at_epoch_ms"),
    updatedAtEpochMs: readInteger(row, "updated_at_epoch_ms"),
    revokedAtEpochMs: readNullableInteger(row, "revoked_at_epoch_ms"),
    revokedReason:
      revokedReason as PushSubscriptionRevocationReason | null,
  };
  validateRecord(record);
  return record;
}

function validateRecord(record: PushSubscriptionRecord): void {
  parsePushSubscription(record.subscription);
  const timestamps = [
    record.createdAtEpochMs,
    record.updatedAtEpochMs,
    ...(record.revokedAtEpochMs === null
      ? []
      : [record.revokedAtEpochMs]),
  ];
  if (
    !record.id ||
    !record.userId ||
    !record.deviceId ||
    timestamps.some(
      (value) => !Number.isSafeInteger(value) || value < 0,
    ) ||
    record.updatedAtEpochMs < record.createdAtEpochMs ||
    (record.revokedAtEpochMs === null) !==
      (record.revokedReason === null) ||
    (record.revokedReason !== null &&
      !REVOCATION_REASONS.has(record.revokedReason))
  ) {
    throw new SqliteDataIntegrityError(
      "Push subscription violates lifecycle invariants.",
    );
  }
}

function validateDedupeInput(
  dedupeKey: string,
  nowEpochMs: number,
): void {
  if (
    dedupeKey.length < 1 ||
    dedupeKey.length > 200 ||
    !/^[A-Za-z0-9:_-]+$/u.test(dedupeKey) ||
    !Number.isSafeInteger(nowEpochMs) ||
    nowEpochMs < 0
  ) {
    throw new SqliteDataIntegrityError("Push dedupe input is invalid.");
  }
}
