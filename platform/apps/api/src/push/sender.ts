import webPush from "web-push";
import type {
  PushSubscription as WebPushSubscription,
  RequestOptions,
} from "web-push";

import type { PushSubscriptionRecord } from "./subscription-store.js";

export type PushUrgency = "very-low" | "low" | "normal" | "high";

export interface PushDeliveryOptions {
  readonly ttlSeconds?: number;
  readonly urgency?: PushUrgency;
  readonly topic?: string;
}

export interface PushSenderInput {
  readonly subscription: PushSubscriptionRecord;
  readonly serializedPayload: string;
  readonly options?: PushDeliveryOptions;
}

export type PushSendOutcome =
  | {
      readonly kind: "delivered";
      readonly statusCode: number;
    }
  | {
      readonly kind: "failed";
      readonly statusCode: number | null;
      readonly reason:
        | "endpoint-gone"
        | "provider-rejected"
        | "transport-error";
      readonly retryable: boolean;
    };

export interface PushSender {
  send(input: PushSenderInput): Promise<PushSendOutcome>;
}

export interface WebPushTransport {
  sendNotification(
    subscription: WebPushSubscription,
    payload: string,
    options: RequestOptions,
  ): Promise<{ readonly statusCode: number }>;
}

export interface VapidConfiguration {
  readonly subject: string;
  readonly publicKey: string;
  readonly privateKey: string;
}

export class WebPushLibrarySender implements PushSender {
  private readonly transport: WebPushTransport;
  private readonly vapid: VapidConfiguration;
  private readonly timeoutMs: number;

  constructor(dependencies: {
    readonly transport?: WebPushTransport;
    readonly vapid: VapidConfiguration;
    readonly timeoutMs?: number;
  }) {
    this.transport = dependencies.transport ?? webPush;
    this.vapid = dependencies.vapid;
    this.timeoutMs = dependencies.timeoutMs ?? 10_000;
  }

  async send(input: PushSenderInput): Promise<PushSendOutcome> {
    const options: RequestOptions = {
      timeout: this.timeoutMs,
      vapidDetails: this.vapid,
    };
    if (input.options?.ttlSeconds !== undefined) {
      options.TTL = input.options.ttlSeconds;
    }
    if (input.options?.urgency !== undefined) {
      options.urgency = input.options.urgency;
    }
    if (input.options?.topic !== undefined) {
      options.topic = input.options.topic;
    }

    try {
      const result = await this.transport.sendNotification(
        input.subscription.subscription,
        input.serializedPayload,
        options,
      );
      return {
        kind: "delivered",
        statusCode: result.statusCode,
      };
    } catch (error) {
      const statusCode = extractStatusCode(error);
      if (statusCode === 404 || statusCode === 410) {
        return {
          kind: "failed",
          statusCode,
          reason: "endpoint-gone",
          retryable: false,
        };
      }
      if (statusCode === null) {
        return {
          kind: "failed",
          statusCode: null,
          reason: "transport-error",
          retryable: true,
        };
      }
      return {
        kind: "failed",
        statusCode,
        reason: "provider-rejected",
        retryable: isRetryableStatus(statusCode),
      };
    }
  }
}

export function shouldRevokeSubscription(
  outcome: PushSendOutcome,
): boolean {
  return (
    outcome.kind === "failed" &&
    outcome.reason === "endpoint-gone" &&
    (outcome.statusCode === 404 || outcome.statusCode === 410)
  );
}

function extractStatusCode(error: unknown): number | null {
  if (
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    typeof error.statusCode === "number" &&
    Number.isInteger(error.statusCode)
  ) {
    return error.statusCode;
  }
  return null;
}

function isRetryableStatus(statusCode: number): boolean {
  return (
    statusCode === 408 ||
    statusCode === 425 ||
    statusCode === 429 ||
    statusCode >= 500
  );
}
