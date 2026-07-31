import {
  serializePushPayload,
  type PushPayload,
} from "./payload.js";
import {
  shouldRevokeSubscription,
  type PushDeliveryOptions,
  type PushSender,
} from "./sender.js";
import type {
  PushSubscriptionRecord,
  PushSubscriptionStore,
} from "./subscription-store.js";

type PushDedupeState = "pending" | "completed";

interface PushDedupeRecord {
  readonly state: PushDedupeState;
  readonly expiresAtEpochMs: number;
}

export interface PushDedupeStore {
  tryStart(dedupeKey: string, nowEpochMs: number): Promise<boolean>;
  complete(dedupeKey: string, nowEpochMs: number): Promise<void>;
  release(dedupeKey: string): Promise<void>;
}

export class InMemoryPushDedupeStore implements PushDedupeStore {
  private readonly records = new Map<string, PushDedupeRecord>();
  private readonly retentionMs: number;
  private readonly pendingLeaseMs: number;

  constructor(options: {
    readonly retentionMs: number;
    readonly pendingLeaseMs?: number;
  }) {
    const pendingLeaseMs =
      options.pendingLeaseMs ??
      Math.min(options.retentionMs, 2 * 60 * 1_000);
    if (
      !Number.isSafeInteger(options.retentionMs) ||
      options.retentionMs <= 0 ||
      !Number.isSafeInteger(pendingLeaseMs) ||
      pendingLeaseMs <= 0 ||
      pendingLeaseMs > options.retentionMs
    ) {
      throw new TypeError(
        "Push dedupe retention and pending lease must be positive safe integers.",
      );
    }
    this.retentionMs = options.retentionMs;
    this.pendingLeaseMs = pendingLeaseMs;
  }

  async tryStart(
    dedupeKey: string,
    nowEpochMs: number,
  ): Promise<boolean> {
    for (const [key, record] of this.records) {
      if (record.expiresAtEpochMs <= nowEpochMs) {
        this.records.delete(key);
      }
    }
    const existing = this.records.get(dedupeKey);
    if (existing && existing.expiresAtEpochMs > nowEpochMs) {
      return false;
    }
    this.records.set(dedupeKey, {
      state: "pending",
      expiresAtEpochMs: nowEpochMs + this.pendingLeaseMs,
    });
    return true;
  }

  async complete(
    dedupeKey: string,
    nowEpochMs: number,
  ): Promise<void> {
    this.records.set(dedupeKey, {
      state: "completed",
      expiresAtEpochMs: nowEpochMs + this.retentionMs,
    });
  }

  async release(dedupeKey: string): Promise<void> {
    const existing = this.records.get(dedupeKey);
    if (existing?.state === "pending") {
      this.records.delete(dedupeKey);
    }
  }
}

export type PushDeliveryResult =
  | { readonly status: "delivered"; readonly statusCode: number }
  | { readonly status: "duplicate" }
  | { readonly status: "subscription-inactive" }
  | {
      readonly status: "subscription-revoked";
      readonly statusCode: 404 | 410;
    }
  | {
      readonly status: "failed";
      readonly statusCode: number | null;
      readonly retryable: boolean;
    };

export class PushDeliveryCoordinator {
  constructor(
    private readonly dependencies: {
      readonly subscriptions: PushSubscriptionStore;
      readonly dedupe: PushDedupeStore;
      readonly sender: PushSender;
      readonly now: () => number;
      readonly authorizeSubscription: (
        subscription: PushSubscriptionRecord,
        nowEpochMs: number,
      ) => Promise<boolean>;
    },
  ) {}

  async deliver(input: {
    readonly subscriptionId: string;
    readonly dedupeKey: string;
    readonly payload: PushPayload;
    readonly options?: PushDeliveryOptions;
  }): Promise<PushDeliveryResult> {
    assertDedupeKey(input.dedupeKey);
    const serializedPayload = serializePushPayload(input.payload);
    const nowEpochMs = this.dependencies.now();
    const started = await this.dependencies.dedupe.tryStart(
      input.dedupeKey,
      nowEpochMs,
    );
    if (!started) {
      return { status: "duplicate" };
    }

    const subscription =
      await this.dependencies.subscriptions.findActiveById(
        input.subscriptionId,
      );
    if (!subscription) {
      await this.dependencies.dedupe.complete(
        input.dedupeKey,
        nowEpochMs,
      );
      return { status: "subscription-inactive" };
    }
    let authorized: boolean;
    try {
      authorized =
        await this.dependencies.authorizeSubscription(
          subscription,
          nowEpochMs,
        );
    } catch (error) {
      await this.dependencies.dedupe.release(input.dedupeKey);
      throw error;
    }
    if (!authorized) {
      await this.dependencies.subscriptions.revoke(subscription.id, {
        atEpochMs: nowEpochMs,
        reason: "device-revoked",
      });
      await this.dependencies.dedupe.complete(
        input.dedupeKey,
        nowEpochMs,
      );
      return { status: "subscription-inactive" };
    }

    let outcome;
    try {
      outcome = await this.dependencies.sender.send({
        subscription,
        serializedPayload,
        ...(input.options === undefined ? {} : { options: input.options }),
      });
    } catch (error) {
      await this.dependencies.dedupe.release(input.dedupeKey);
      throw error;
    }

    if (outcome.kind === "delivered") {
      await this.dependencies.dedupe.complete(
        input.dedupeKey,
        nowEpochMs,
      );
      return {
        status: "delivered",
        statusCode: outcome.statusCode,
      };
    }

    if (shouldRevokeSubscription(outcome)) {
      await this.dependencies.subscriptions.revoke(subscription.id, {
        atEpochMs: nowEpochMs,
        reason: "push-endpoint-gone",
      });
      await this.dependencies.dedupe.complete(
        input.dedupeKey,
        nowEpochMs,
      );
      return {
        status: "subscription-revoked",
        statusCode: outcome.statusCode as 404 | 410,
      };
    }

    if (outcome.retryable) {
      await this.dependencies.dedupe.release(input.dedupeKey);
    } else {
      await this.dependencies.dedupe.complete(
        input.dedupeKey,
        nowEpochMs,
      );
    }
    return {
      status: "failed",
      statusCode: outcome.statusCode,
      retryable: outcome.retryable,
    };
  }
}

function assertDedupeKey(dedupeKey: string): void {
  if (
    dedupeKey.length < 1 ||
    dedupeKey.length > 200 ||
    !/^[A-Za-z0-9:_-]+$/u.test(dedupeKey)
  ) {
    throw new TypeError("dedupeKey has an invalid format");
  }
}
