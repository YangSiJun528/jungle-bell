import { describe, expect, it, vi } from "vitest";
import {
  deliverDuePushes,
  isAllowedBrowserPushEndpoint,
  PUSH_DELIVERY_LEASE_TTL_MS,
  type PushSender,
} from "../renewal/push-sender";
import type {
  AppSessionRecord,
  NotificationRecord,
  PushDeliveryRecord,
  PushSubscriptionRecord,
  RenewalStore,
} from "../ports/account-storage";
import { MemoryRenewalStore } from "./helpers/memory-renewal-store";

function subscription(index: number): PushSubscriptionRecord {
  return { id: `sub-${index}`, userId: "user", sessionId: "mobile", endpoint: `https://push.test/${index}`,
    p256dh: "p".repeat(65), auth: "a".repeat(24), createdAtEpochMs: 0, revokedAtEpochMs: null };
}

function mobileSession(expiresAtEpochMs = 20 * 60_000): AppSessionRecord {
  return {
    id: "mobile",
    userId: "user",
    installationId: `jbmi_${"a".repeat(32)}`,
    kind: "mobile",
    label: "test mobile",
    tokenSha256: "b".repeat(64),
    createdAtEpochMs: 0,
    expiresAtEpochMs,
    lastSeenAtEpochMs: 0,
    revokedAtEpochMs: null,
    sourcePairingId: null,
  };
}

function notification(): NotificationRecord {
  return { id: "notification", userId: "user", sourceEventId: "event", kind: "attendance-action-required",
    title: "title", body: "body", path: "/dashboard.html#attendance", payloadJson: JSON.stringify({ title: "title" }),
    createdAtEpochMs: 0, dueAtEpochMs: 0, expiresAtEpochMs: 10 * 60_000, desktopAttempt: 0 };
}

describe("Web Push delivery", () => {
  it.each([
    "https://fcm.googleapis.com/fcm/send/one",
    "https://updates.push.services.mozilla.com/wpush/v2/one",
    "https://web.push.apple.com/Qexample",
    "https://wns2-by3p.notify.windows.com/?token=one",
  ])("accepts a known browser push service endpoint: %s", (endpoint) => {
    expect(isAllowedBrowserPushEndpoint(endpoint)).toBe(true);
  });

  it.each([
    "http://fcm.googleapis.com/fcm/send/one",
    "https://user:password@fcm.googleapis.com/fcm/send/one",
    "https://127.0.0.1/subscriptions/one",
    "https://169.254.169.254/latest/meta-data",
    "https://web.push.apple.com.evil.test/subscriptions/one",
    "https://web.push.apple.com:8443/subscriptions/one",
    "https://push.example.test/subscriptions/one",
  ])("rejects a non-browser or unsafe push endpoint: %s", (endpoint) => {
    expect(isAllowedBrowserPushEndpoint(endpoint)).toBe(false);
  });

  it("bounds parallel sends at ten and terminates the eighth failed attempt", async () => {
    let active = 0;
    let maximum = 0;
    const deliveries: PushDeliveryRecord[] = Array.from({ length: 25 }, (_, index) => ({
      notificationId: `n-${index}`, subscription: subscription(index), payloadJson: "{}",
      expiresAtEpochMs: 10 * 60_000, attempts: index === 0 ? 7 : 0, leaseToken: "unclaimed",
    }));
    const results: Array<{ notificationId: string; status: string }> = [];
    let resultBatchCalls = 0;
    const store = {
      claimDuePushDeliveries: async (input: { leaseToken: string }) =>
        deliveries.map((delivery) => ({ ...delivery, leaseToken: input.leaseToken })),
      recordPushDeliveryResults: async (inputs: Array<{ notificationId: string; status: string }>) => {
        resultBatchCalls += 1;
        results.push(...inputs);
      },
    } as unknown as RenewalStore;
    const sender: PushSender = {
      send: async () => {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active -= 1;
        return { status: "retry", error: "temporary" };
      },
    };

    expect(await deliverDuePushes(store, sender, 0)).toBe(25);
    expect(maximum).toBeLessThanOrEqual(10);
    expect(maximum).toBeGreaterThan(1);
    expect(results.find((result) => result.notificationId === "n-0")?.status).toBe("failed");
    expect(resultBatchCalls).toBe(1);
  });

  it("expires an attendance notification instead of delivering it after its ten-minute window", async () => {
    const store = new MemoryRenewalStore();
    store.sessions.set("mobile", mobileSession());
    await store.upsertPushSubscription(subscription(1));
    await store.insertNotification(notification());
    const sender: PushSender = { send: vi.fn(async () => ({ status: "delivered" as const, error: null })) };

    expect(await deliverDuePushes(store, sender, 10 * 60_000)).toBe(0);
    expect(sender.send).not.toHaveBeenCalled();
    expect(store.deliveries.get("notification:sub-1")).toMatchObject({ status: "failed", error: "NOTIFICATION_EXPIRED" });
    expect(await store.listDesktopInbox("user", "desktop", 10 * 60_000, 20)).toEqual([]);
  });

  it("does not select or deliver Web Push after the owning mobile session expires", async () => {
    const store = new MemoryRenewalStore();
    store.sessions.set("mobile", mobileSession(1_000));
    await store.upsertPushSubscription(subscription(1));
    await store.insertNotification(notification());
    const sender: PushSender = { send: vi.fn(async () => ({ status: "delivered" as const, error: null })) };

    expect(await store.listActivePushSubscriptions("user", 999)).toHaveLength(1);
    expect(await store.listActivePushSubscriptions("user", 1_000)).toEqual([]);
    expect(await deliverDuePushes(store, sender, 1_000)).toBe(0);
    expect(sender.send).not.toHaveBeenCalled();
  });

  it("fails observably instead of dropping a due push when no sender is configured", async () => {
    const store = new MemoryRenewalStore();
    store.sessions.set("mobile", mobileSession());
    await store.upsertPushSubscription(subscription(1));
    await store.insertNotification(notification());

    await expect(deliverDuePushes(store, null, 0)).rejects.toThrow("WEB_PUSH_SENDER_NOT_CONFIGURED");
    expect(store.deliveries.get("notification:sub-1")?.status).toBe("pending");
  });

  it("never delivers a previous user's payload after a push endpoint is reassigned", async () => {
    const store = new MemoryRenewalStore();
    store.sessions.set("mobile", mobileSession());
    await store.upsertPushSubscription(subscription(1));
    await store.insertNotification(notification());

    store.sessions.set("mobile-b", {
      ...mobileSession(),
      id: "mobile-b",
      userId: "user-b",
      installationId: `jbmi_${"b".repeat(32)}`,
      tokenSha256: "d".repeat(64),
    });
    await store.upsertPushSubscription({
      ...subscription(1),
      userId: "user-b",
      sessionId: "mobile-b",
      createdAtEpochMs: 1,
    });

    expect(store.deliveries.get("notification:sub-1")).toMatchObject({
      status: "failed",
      error: "PUSH_SUBSCRIPTION_REASSIGNED",
    });
    const delivery = store.deliveries.get("notification:sub-1")!;
    delivery.status = "pending";
    delivery.nextAttempt = 0;
    expect(await store.claimDuePushDeliveries({
      nowEpochMs: 0, limit: 100, leaseToken: "lease-after-reassignment",
      leaseExpiresAtEpochMs: PUSH_DELIVERY_LEASE_TTL_MS,
    })).toEqual([]);
  });

  it("leases each due delivery atomically and ignores a stale worker result after lease expiry", async () => {
    const store = new MemoryRenewalStore();
    store.sessions.set("mobile", mobileSession());
    await store.upsertPushSubscription(subscription(1));
    await store.insertNotification(notification());

    const first = await store.claimDuePushDeliveries({
      nowEpochMs: 0, limit: 100, leaseToken: "lease-first",
      leaseExpiresAtEpochMs: PUSH_DELIVERY_LEASE_TTL_MS,
    });
    expect(first).toHaveLength(1);
    await expect(store.claimDuePushDeliveries({
      nowEpochMs: 1, limit: 100, leaseToken: "lease-overlap",
      leaseExpiresAtEpochMs: 1 + PUSH_DELIVERY_LEASE_TTL_MS,
    })).resolves.toEqual([]);

    const second = await store.claimDuePushDeliveries({
      nowEpochMs: PUSH_DELIVERY_LEASE_TTL_MS, limit: 100, leaseToken: "lease-second",
      leaseExpiresAtEpochMs: 2 * PUSH_DELIVERY_LEASE_TTL_MS,
    });
    expect(second).toHaveLength(1);
    await store.recordPushDeliveryResults([{
      notificationId: "notification", subscriptionId: "sub-1", leaseToken: "lease-first",
      status: "delivered", nowEpochMs: PUSH_DELIVERY_LEASE_TTL_MS,
      nextAttemptAtEpochMs: null, error: null,
    }]);
    expect(store.deliveries.get("notification:sub-1")?.status).toBe("pending");

    await store.recordPushDeliveryResults([{
      notificationId: "notification", subscriptionId: "sub-1", leaseToken: "lease-second",
      status: "delivered", nowEpochMs: PUSH_DELIVERY_LEASE_TTL_MS,
      nextAttemptAtEpochMs: null, error: null,
    }]);
    expect(store.deliveries.get("notification:sub-1")).toMatchObject({
      status: "delivered", leaseToken: null,
    });
  });
});
