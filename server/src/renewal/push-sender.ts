import type { PushDeliveryRecord, RenewalStore } from "../workers/account-storage";

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

export interface PushRelayBinding {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

function relayRequest(
  delivery: PushDeliveryRecord,
  nowEpochMs: number,
  headers: Record<string, string> = {},
): RequestInit {
  return {
    method: "POST",
    signal: AbortSignal.timeout(10_000),
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({
      endpoint: delivery.subscription.endpoint,
      keys: { p256dh: delivery.subscription.p256dh, auth: delivery.subscription.auth },
      payload: JSON.parse(delivery.payloadJson) as unknown,
      ttl: Math.max(0, Math.min(15 * 60, Math.ceil((delivery.expiresAtEpochMs - nowEpochMs) / 1_000))),
      urgency: "high",
    }),
  };
}

async function sendToRelay(request: () => Promise<Response>): Promise<{ status: "delivered" | "retry" | "gone"; error: string | null }> {
  try {
    const response = await request();
    if (response.status === 404 || response.status === 410) return { status: "gone", error: `HTTP_${response.status}` };
    if (response.ok) return { status: "delivered", error: null };
    return { status: "retry", error: `HTTP_${response.status}` };
  } catch {
    return { status: "retry", error: "WEB_PUSH_RELAY_UNAVAILABLE" };
  }
}

/**
 * HTTPS relay boundary for a Workers-compatible Web Push sender. The relay owns
 * RFC 8291 encryption and VAPID signing; the credential is a Worker secret.
 */
export class HttpPushRelaySender implements PushSender {
  constructor(private readonly url: string, private readonly bearerToken: string, private readonly fetcher: typeof fetch = fetch) {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || !bearerToken) throw new Error("WEB_PUSH_RELAY_CONFIGURATION_INVALID");
  }

  async send(delivery: PushDeliveryRecord, nowEpochMs: number): Promise<{ status: "delivered" | "retry" | "gone"; error: string | null }> {
    return sendToRelay(() => this.fetcher(this.url, relayRequest(delivery, nowEpochMs, {
      authorization: `Bearer ${this.bearerToken}`,
    })));
  }
}

/**
 * A Cloudflare Service Binding is already authenticated by the Workers runtime,
 * so this sender does not need a duplicate public URL or bearer-token secret.
 */
export class BindingPushRelaySender implements PushSender {
  constructor(private readonly binding: PushRelayBinding) {}

  async send(delivery: PushDeliveryRecord, nowEpochMs: number): Promise<{ status: "delivered" | "retry" | "gone"; error: string | null }> {
    return sendToRelay(() => this.binding.fetch(
      "https://web-push-relay.internal/send",
      relayRequest(delivery, nowEpochMs),
    ));
  }
}

export async function deliverDuePushes(store: RenewalStore, sender: PushSender | null, nowEpochMs: number): Promise<number> {
  const deliveries = await store.listDuePushDeliveries(nowEpochMs, 100);
  if (!sender) {
    if (deliveries.length > 0) throw new Error("WEB_PUSH_SENDER_NOT_CONFIGURED");
    return 0;
  }
  await mapBounded(deliveries, 10, async (delivery) => {
    const result = await sender.send(delivery, nowEpochMs);
    const attempts = delivery.attempts + 1;
    const retryDelay = Math.min(60 * 60_000, 30_000 * 2 ** Math.min(attempts - 1, 7));
    const terminalFailure = result.status === "retry" && attempts >= 8;
    await store.recordPushDeliveryResult({
      notificationId: delivery.notificationId,
      subscriptionId: delivery.subscription.id,
      status: terminalFailure ? "failed" : result.status,
      nowEpochMs,
      nextAttemptAtEpochMs: result.status === "retry" && !terminalFailure ? nowEpochMs + retryDelay : null,
      error: terminalFailure ? "WEB_PUSH_RETRY_EXHAUSTED" : result.error,
    });
  });
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
