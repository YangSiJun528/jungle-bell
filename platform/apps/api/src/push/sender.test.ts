import { describe, expect, it, vi } from "vitest";

import {
  WebPushLibrarySender,
  shouldRevokeSubscription,
  type WebPushTransport,
} from "./sender";
import type { PushSubscriptionRecord } from "./subscription-store";

const { packageSendNotification } = vi.hoisted(() => ({
  packageSendNotification: vi.fn(),
}));

vi.mock("web-push", () => ({
  default: {
    sendNotification: packageSendNotification,
  },
}));

const subscription: PushSubscriptionRecord = {
  id: "push-1",
  userId: "user-1",
  deviceId: "phone-1",
  subscription: {
    endpoint: "https://updates.push.services.mozilla.com/wpush/one",
    expirationTime: null,
    keys: {
      auth: "a".repeat(22),
      p256dh: "b".repeat(87),
    },
  },
  createdAtEpochMs: 0,
  updatedAtEpochMs: 0,
  revokedAtEpochMs: null,
  revokedReason: null,
};

function sender(transport: WebPushTransport): WebPushLibrarySender {
  return new WebPushLibrarySender({
    transport,
    vapid: {
      subject: "mailto:admin@example.test",
      publicKey: "public-key",
      privateKey: "private-key",
    },
    timeoutMs: 5_000,
  });
}

describe("WebPushLibrarySender", () => {
  it("uses the CommonJS web-push default export when no transport is injected", async () => {
    packageSendNotification.mockResolvedValueOnce({ statusCode: 201 });
    const instance = new WebPushLibrarySender({
      vapid: {
        subject: "mailto:admin@example.test",
        publicKey: "public-key",
        privateKey: "private-key",
      },
    });

    await expect(
      instance.send({
        subscription,
        serializedPayload: '{"version":1}',
      }),
    ).resolves.toEqual({ kind: "delivered", statusCode: 201 });
    expect(packageSendNotification).toHaveBeenCalledOnce();
  });

  it("passes a serialized payload and bounded delivery options to web-push", async () => {
    const sendNotification = vi.fn(async () => ({
      statusCode: 201,
      body: "",
      headers: {},
    }));
    const instance = sender({ sendNotification });

    await expect(
      instance.send({
        subscription,
        serializedPayload: '{"version":1}',
        options: {
          ttlSeconds: 300,
          urgency: "normal",
          topic: "meal_lunch",
        },
      }),
    ).resolves.toEqual({ kind: "delivered", statusCode: 201 });

    expect(sendNotification).toHaveBeenCalledWith(
      subscription.subscription,
      '{"version":1}',
      {
        TTL: 300,
        timeout: 5_000,
        topic: "meal_lunch",
        urgency: "normal",
        vapidDetails: {
          subject: "mailto:admin@example.test",
          publicKey: "public-key",
          privateKey: "private-key",
        },
      },
    );
  });

  it.each([404, 410])(
    "classifies HTTP %s as a terminal endpoint and eligible for revocation",
    async (statusCode) => {
      const instance = sender({
        sendNotification: vi.fn(async () => {
          throw { statusCode };
        }),
      });

      const outcome = await instance.send({
        subscription,
        serializedPayload: '{"version":1}',
      });

      expect(outcome).toEqual({
        kind: "failed",
        statusCode,
        reason: "endpoint-gone",
        retryable: false,
      });
      expect(shouldRevokeSubscription(outcome)).toBe(true);
    },
  );

  it("classifies throttling and transport failures as retryable", async () => {
    const throttled = sender({
      sendNotification: vi.fn(async () => {
        throw { statusCode: 429 };
      }),
    });
    const transportFailure = sender({
      sendNotification: vi.fn(async () => {
        throw new Error("socket reset");
      }),
    });

    await expect(
      throttled.send({
        subscription,
        serializedPayload: '{"version":1}',
      }),
    ).resolves.toEqual({
      kind: "failed",
      statusCode: 429,
      reason: "provider-rejected",
      retryable: true,
    });
    await expect(
      transportFailure.send({
        subscription,
        serializedPayload: '{"version":1}',
      }),
    ).resolves.toEqual({
      kind: "failed",
      statusCode: null,
      reason: "transport-error",
      retryable: true,
    });
  });
});
