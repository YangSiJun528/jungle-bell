import webPush from "web-push";
import { describe, expect, it, vi } from "vitest";
import type { PushDeliveryRecord } from "../../../shared/ports/account-storage";
import { NodeWebPushSender } from "../src/clients/web-push-sender";

const vapid = webPush.generateVAPIDKeys();

const delivery: PushDeliveryRecord = {
  notificationId: "notification-1",
  subscription: {
    id: "subscription-1",
    userId: "user-1",
    sessionId: "session-1",
    endpoint: "https://fcm.googleapis.com/fcm/send/example",
    p256dh: "p".repeat(80),
    auth: "a".repeat(24),
    createdAtEpochMs: 0,
    revokedAtEpochMs: null,
  },
  payloadJson: JSON.stringify({ title: "알림" }),
  expiresAtEpochMs: 10 * 60_000,
  attempts: 0,
  leaseToken: "lease-1",
};

describe("NodeWebPushSender", () => {
  it("sends encrypted Web Push directly with bounded TTL and VAPID credentials", async () => {
    const sendNotification = vi.fn(async () => ({ statusCode: 201, headers: {}, body: "" }));
    const sender = new NodeWebPushSender({
      subject: "mailto:admin@example.com",
      publicKey: vapid.publicKey,
      privateKey: vapid.privateKey,
    }, { sendNotification } as unknown as typeof webPush);

    await expect(sender.send(delivery, 0)).resolves.toEqual({ status: "delivered", error: null });
    expect(sendNotification).toHaveBeenCalledWith(
      {
        endpoint: delivery.subscription.endpoint,
        keys: { p256dh: delivery.subscription.p256dh, auth: delivery.subscription.auth },
      },
      delivery.payloadJson,
      expect.objectContaining({
        TTL: 600,
        urgency: "high",
        timeout: 10_000,
        vapidDetails: {
          subject: "mailto:admin@example.com",
          publicKey: vapid.publicKey,
          privateKey: vapid.privateKey,
        },
      }),
    );
  });

  it.each([404, 410])("marks HTTP %i provider responses as a gone subscription", async (statusCode) => {
    const transport = {
      sendNotification: vi.fn(async () => {
        throw Object.assign(new Error("gone"), { statusCode });
      }),
    };
    const sender = new NodeWebPushSender({
      subject: "mailto:admin@example.com", publicKey: vapid.publicKey, privateKey: vapid.privateKey,
    }, transport as unknown as typeof webPush);

    await expect(sender.send(delivery, 0)).resolves.toEqual({ status: "gone", error: `HTTP_${statusCode}` });
  });

  it("retries provider and network failures without leaking their response bodies", async () => {
    const transport = {
      sendNotification: vi.fn(async () => {
        throw Object.assign(new Error("provider secret body"), { statusCode: 503 });
      }),
    };
    const sender = new NodeWebPushSender({
      subject: "mailto:admin@example.com", publicKey: vapid.publicKey, privateKey: vapid.privateKey,
    }, transport as unknown as typeof webPush);

    await expect(sender.send(delivery, 0)).resolves.toEqual({ status: "retry", error: "HTTP_503" });
  });

  it("keeps a 12-hour meal notification deliverable while the device is offline", async () => {
    const sendNotification = vi.fn(async () => ({ statusCode: 201, headers: {}, body: "" }));
    const sender = new NodeWebPushSender({
      subject: "mailto:admin@example.com", publicKey: vapid.publicKey, privateKey: vapid.privateKey,
    }, { sendNotification } as unknown as typeof webPush);

    await sender.send({ ...delivery, expiresAtEpochMs: 12 * 60 * 60_000 }, 0);

    expect(sendNotification).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), expect.objectContaining({ TTL: 12 * 60 * 60 }),
    );
  });

  it("rejects an invalid subject, malformed key, or mismatched VAPID pair at startup", () => {
    const other = webPush.generateVAPIDKeys();
    expect(() => new NodeWebPushSender({
      subject: "http://example.com", publicKey: vapid.publicKey, privateKey: vapid.privateKey,
    })).toThrow("VAPID_CONFIGURATION_INVALID");
    expect(() => new NodeWebPushSender({
      subject: "mailto:admin@example.com", publicKey: "invalid", privateKey: vapid.privateKey,
    })).toThrow("VAPID_CONFIGURATION_INVALID");
    expect(() => new NodeWebPushSender({
      subject: "mailto:admin@example.com", publicKey: vapid.publicKey, privateKey: other.privateKey,
    })).toThrow("VAPID_CONFIGURATION_INVALID");
  });
});
