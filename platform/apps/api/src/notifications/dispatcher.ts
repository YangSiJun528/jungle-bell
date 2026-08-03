import { createHash } from "node:crypto";

import type { PushDeliveryCoordinator } from "../push/coordinator.js";
import type { PushPayload } from "../push/payload.js";
import type {
  NotificationDelivery,
  NotificationSourceEvent,
  NotificationTargetDirectory,
} from "./contracts.js";
import type {
  LaundryNotificationLifecycle,
} from "./laundry-lifecycle.js";
import type { ServerNotificationPlanner } from "./planner.js";
import type { NotificationRepository } from "./repository.js";

const MAX_ATTEMPTS = 8;
const OUTBOX_LEASE_MS = 30_000;
const WEB_PUSH_LEASE_MS = 5 * 60_000;
const WEB_PUSH_CONCURRENCY = 10;

export interface NotificationDeliveryAdapter {
  deliver(
    delivery: NotificationDelivery,
  ): Promise<
    | { readonly status: "delivered" }
    | {
        readonly status: "failed";
        readonly retryable: boolean;
        readonly errorCode: string;
      }
  >;
}

export class WebPushNotificationAdapter
  implements NotificationDeliveryAdapter
{
  private readonly now: () => number;

  constructor(
    private readonly coordinator: PushDeliveryCoordinator,
    options: { readonly now?: () => number } = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  async deliver(
    delivery: NotificationDelivery,
  ): Promise<
    | { readonly status: "delivered" }
    | {
        readonly status: "failed";
        readonly retryable: boolean;
        readonly errorCode: string;
      }
  > {
    const event = delivery.event.intent;
    const remainingTtlMs = event.expiresAtEpochMs - this.now();
    if (remainingTtlMs <= 0) {
      return {
        status: "failed",
        retryable: false,
        errorCode: "EVENT_EXPIRED",
      };
    }
    const remainingTtlSeconds = Math.floor(
      remainingTtlMs / 1_000,
    );
    const payload: PushPayload = {
      version: 1,
      title: event.content.title,
      body: event.content.body,
      path: event.content.path,
      tag: pushTag(event.dedupeKey),
    };
    const result = await this.coordinator.deliver({
      subscriptionId: delivery.destinationId,
      dedupeKey: `outbox:${delivery.id}`,
      payload,
      options: {
        ttlSeconds: Math.min(
          ttlFor(event.kind),
          remainingTtlSeconds,
        ),
        urgency:
          event.kind === "attendance-action-required" ||
          event.kind === "login-required"
            ? "high"
            : "normal",
        topic: pushTopic(event.dedupeKey),
      },
    });
    switch (result.status) {
      case "delivered":
      case "duplicate":
        return { status: "delivered" };
      case "failed":
        return {
          status: "failed",
          retryable: result.retryable,
          errorCode:
            result.statusCode === null
              ? "PUSH_TRANSPORT"
              : `PUSH_HTTP_${result.statusCode}`,
        };
      case "subscription-inactive":
        return {
          status: "failed",
          retryable: false,
          errorCode: "PUSH_SUBSCRIPTION_INACTIVE",
        };
      case "subscription-revoked":
        return {
          status: "failed",
          retryable: false,
          errorCode: "PUSH_SUBSCRIPTION_REVOKED",
        };
    }
  }
}

export class NotificationService {
  private readonly now: () => number;

  constructor(
    private readonly dependencies: {
      readonly planner: ServerNotificationPlanner;
      readonly repository: NotificationRepository;
      readonly targets: NotificationTargetDirectory;
      readonly webPush: NotificationDeliveryAdapter;
      readonly laundryLifecycle?: LaundryNotificationLifecycle;
      readonly now?: () => number;
      readonly logger?: { warn(message: string): void };
    },
  ) {
    this.now = dependencies.now ?? Date.now;
  }

  record(event: NotificationSourceEvent): {
    readonly planned: number;
    readonly inserted: number;
  } {
    if (
      event.kind === "laundry-transition" &&
      this.dependencies.laundryLifecycle !== undefined
    ) {
      return this.dependencies.laundryLifecycle.record(event);
    }
    const intents = this.dependencies.planner.plan(event);
    let inserted = 0;
    for (const intent of intents) {
      const result = this.dependencies.repository.enqueueIntent(
        intent,
        this.now(),
      );
      if (result.inserted) inserted += 1;
    }
    return { planned: intents.length, inserted };
  }

  async runDue(input: {
    readonly outboxLimit?: number;
    readonly deliveryLimit?: number;
  } = {}): Promise<{
    readonly fannedOut: number;
    readonly delivered: number;
    readonly retried: number;
    readonly failed: number;
  }> {
    const nowEpochMs = this.now();
    this.dependencies.laundryLifecycle?.runDue(nowEpochMs);
    let fannedOut = 0;
    let delivered = 0;
    let retried = 0;
    let failed = 0;

    const outbox = this.dependencies.repository.claimOutbox(
      nowEpochMs,
      input.outboxLimit ?? 100,
      OUTBOX_LEASE_MS,
    );
    for (const claimed of outbox) {
      try {
        const targets = await this.dependencies.targets.listTargets(
          claimed.event.intent.userId,
        );
        fannedOut += this.dependencies.repository.createDeliveries(
          claimed.event,
          targets,
          nowEpochMs,
        );
        this.dependencies.repository.completeOutbox(
          claimed.event.id,
          this.now(),
        );
      } catch {
        const terminal = claimed.attempt >= MAX_ATTEMPTS;
        this.dependencies.repository.retryOutbox(
          claimed.event.id,
          this.now(),
          this.now() + retryBackoffMs(claimed.attempt),
          "TARGET_RESOLUTION_FAILED",
          terminal,
        );
        if (terminal) failed += 1;
        else retried += 1;
        this.dependencies.logger?.warn(
          "notification target resolution failed",
        );
      }
    }

    const deliveries =
      this.dependencies.repository.claimWebPushDeliveries(
        this.now(),
        input.deliveryLimit ?? 100,
        WEB_PUSH_LEASE_MS,
      );
    const outcomes = await mapWithConcurrency(
      deliveries,
      WEB_PUSH_CONCURRENCY,
      (delivery) => this.deliverOne(delivery),
    );
    for (const outcome of outcomes) {
      if (outcome === "delivered") delivered += 1;
      if (outcome === "retried") retried += 1;
      if (outcome === "failed") failed += 1;
    }
    return { fannedOut, delivered, retried, failed };
  }

  private async deliverOne(
    delivery: NotificationDelivery,
  ): Promise<"delivered" | "retried" | "failed" | "unchanged"> {
    let result:
      | { readonly status: "delivered" }
      | {
          readonly status: "failed";
          readonly retryable: boolean;
          readonly errorCode: string;
        };
    try {
      result = await this.dependencies.webPush.deliver(delivery);
    } catch {
      result = {
        status: "failed",
        retryable: true,
        errorCode: "DELIVERY_ADAPTER_ERROR",
      };
    }
    if (result.status === "delivered") {
      return this.dependencies.repository.markDeliverySucceeded(
        delivery.id,
        this.now(),
      )
        ? "delivered"
        : "unchanged";
    }
    const terminal =
      !result.retryable || delivery.attempt >= MAX_ATTEMPTS;
    const transitioned =
      this.dependencies.repository.retryDelivery(
        delivery.id,
        this.now(),
        this.now() + retryBackoffMs(delivery.attempt),
        result.errorCode,
        terminal,
      );
    if (!transitioned) return "unchanged";
    return terminal ? "failed" : "retried";
  }
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await operation(values[index]!);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

export function retryBackoffMs(attempt: number): number {
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new TypeError("Delivery attempt must be a positive integer.");
  }
  return Math.min(
    60 * 60_000,
    5_000 * 2 ** Math.min(attempt - 1, 9),
  );
}

function pushTag(dedupeKey: string): string {
  return `jbn_${createHash("sha256")
    .update(dedupeKey)
    .digest("hex")
    .slice(0, 40)}`;
}

function pushTopic(dedupeKey: string): string {
  return `jbn_${createHash("sha256")
    .update(dedupeKey)
    .digest("hex")
    .slice(0, 28)}`;
}

function ttlFor(kind: NotificationDelivery["event"]["intent"]["kind"]): number {
  switch (kind) {
    case "attendance-action-required":
      return 60 * 60;
    case "laundry-finishing":
    case "laundry-completed":
    case "laundry-available":
    case "laundry-attention":
      return 6 * 60 * 60;
    case "login-required":
      return 24 * 60 * 60;
    case "meal-published":
      return 12 * 60 * 60;
  }
}
