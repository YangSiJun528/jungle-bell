import type { BrowserPushSubscription } from "./payload.js";

export type PushSubscriptionRevocationReason =
  | "push-endpoint-gone"
  | "user-unsubscribed"
  | "device-revoked"
  | "replaced";

export interface PushSubscriptionRecord {
  id: string;
  userId: string;
  deviceId: string;
  subscription: BrowserPushSubscription;
  createdAtEpochMs: number;
  updatedAtEpochMs: number;
  revokedAtEpochMs: number | null;
  revokedReason: PushSubscriptionRevocationReason | null;
}

export interface RevokePushSubscriptionInput {
  readonly atEpochMs: number;
  readonly reason: PushSubscriptionRevocationReason;
}

export interface PushSubscriptionStore {
  upsert(record: PushSubscriptionRecord): Promise<boolean>;
  findById(id: string): Promise<PushSubscriptionRecord | undefined>;
  findActiveById(id: string): Promise<PushSubscriptionRecord | undefined>;
  listActiveByUserId(userId: string): Promise<PushSubscriptionRecord[]>;
  revoke(
    id: string,
    input: RevokePushSubscriptionInput,
  ): Promise<boolean>;
}

export class InMemoryPushSubscriptionStore
  implements PushSubscriptionStore
{
  private readonly records = new Map<string, PushSubscriptionRecord>();

  async upsert(record: PushSubscriptionRecord): Promise<boolean> {
    const existing = this.records.get(record.id);
    if (
      existing &&
      (existing.userId !== record.userId ||
        existing.deviceId !== record.deviceId) &&
      existing.revokedReason !== "device-revoked"
    ) {
      return false;
    }
    if (record.revokedAtEpochMs === null) {
      const activeForDevice = [...this.records.values()].find(
        (candidate) =>
          candidate.id !== record.id &&
          candidate.userId === record.userId &&
          candidate.deviceId === record.deviceId &&
          candidate.revokedAtEpochMs === null,
      );
      if (activeForDevice) {
        return false;
      }
    }
    this.records.set(record.id, cloneRecord(record));
    return true;
  }

  async findById(
    id: string,
  ): Promise<PushSubscriptionRecord | undefined> {
    const record = this.records.get(id);
    return record ? cloneRecord(record) : undefined;
  }

  async findActiveById(
    id: string,
  ): Promise<PushSubscriptionRecord | undefined> {
    const record = this.records.get(id);
    if (!record || record.revokedAtEpochMs !== null) {
      return undefined;
    }
    return cloneRecord(record);
  }

  async listActiveByUserId(
    userId: string,
  ): Promise<PushSubscriptionRecord[]> {
    return [...this.records.values()]
      .filter(
        (record) =>
          record.userId === userId && record.revokedAtEpochMs === null,
      )
      .map(cloneRecord);
  }

  async revoke(
    id: string,
    input: RevokePushSubscriptionInput,
  ): Promise<boolean> {
    const record = this.records.get(id);
    if (!record || record.revokedAtEpochMs !== null) {
      return false;
    }
    this.records.set(id, {
      ...record,
      updatedAtEpochMs: input.atEpochMs,
      revokedAtEpochMs: input.atEpochMs,
      revokedReason: input.reason,
    });
    return true;
  }
}

function cloneRecord(
  record: PushSubscriptionRecord,
): PushSubscriptionRecord {
  return {
    ...record,
    subscription: {
      ...record.subscription,
      keys: { ...record.subscription.keys },
    },
  };
}
