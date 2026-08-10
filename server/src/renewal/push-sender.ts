import type { PushDeliveryRecord, RenewalStore } from "../workers/account-storage";
import { randomOpaqueToken } from "./crypto";

export const PUSH_DELIVERY_LEASE_TTL_MS = 5 * 60_000;

const EXACT_BROWSER_PUSH_HOSTS = new Set([
  "fcm.googleapis.com",
  "push.services.mozilla.com",
  "updates.push.services.mozilla.com",
  "web.push.apple.com",
]);

export function isAllowedBrowserPushEndpoint(value: string): boolean {
  try {
    const endpoint = new URL(value);
    const hostname = endpoint.hostname.toLowerCase();
    return endpoint.protocol === "https:"
      && endpoint.username === ""
      && endpoint.password === ""
      && (endpoint.port === "" || endpoint.port === "443")
      && (EXACT_BROWSER_PUSH_HOSTS.has(hostname) || hostname.endsWith(".notify.windows.com"));
  } catch {
    return false;
  }
}

export interface PushSender {
  send(delivery: PushDeliveryRecord, nowEpochMs: number): Promise<{ status: "delivered" | "retry" | "gone"; error: string | null }>;
}

export async function deliverDuePushes(store: RenewalStore, sender: PushSender | null, nowEpochMs: number): Promise<number> {
  const leaseToken = randomOpaqueToken("jbpd_");
  const deliveries = await store.claimDuePushDeliveries({
    nowEpochMs,
    limit: 100,
    leaseToken,
    leaseExpiresAtEpochMs: nowEpochMs + PUSH_DELIVERY_LEASE_TTL_MS,
  });
  if (!sender) {
    if (deliveries.length > 0) throw new Error("WEB_PUSH_SENDER_NOT_CONFIGURED");
    return 0;
  }
  const results: Parameters<RenewalStore["recordPushDeliveryResults"]>[0][number][] = [];
  await mapBounded(deliveries, 10, async (delivery) => {
    const result = await sender.send(delivery, nowEpochMs);
    const attempts = delivery.attempts + 1;
    const retryDelay = Math.min(60 * 60_000, 30_000 * 2 ** Math.min(attempts - 1, 7));
    const terminalFailure = result.status === "retry" && attempts >= 8;
    results.push({
      notificationId: delivery.notificationId,
      subscriptionId: delivery.subscription.id,
      leaseToken: delivery.leaseToken,
      status: terminalFailure ? "failed" : result.status,
      nowEpochMs,
      nextAttemptAtEpochMs: result.status === "retry" && !terminalFailure ? nowEpochMs + retryDelay : null,
      error: terminalFailure ? "WEB_PUSH_RETRY_EXHAUSTED" : result.error,
    });
  });
  if (results.length > 0) await store.recordPushDeliveryResults(results);
  return deliveries.length;
}

async function mapBounded<T>(values: readonly T[], concurrency: number, task: (value: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      await task(values[index]!);
    }
  }));
}
