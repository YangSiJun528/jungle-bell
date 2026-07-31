import { describe, expect, it } from "vitest";

import {
  InMemoryPushDedupeStore,
  PushDeliveryCoordinator,
} from "./coordinator";
import type { PushSendOutcome, PushSender } from "./sender";
import {
  InMemoryPushSubscriptionStore,
  type PushSubscriptionRecord,
} from "./subscription-store";

class FakeSender implements PushSender {
  readonly sentPayloads: string[] = [];
  outcomes: PushSendOutcome[] = [
    { kind: "delivered", statusCode: 201 },
  ];

  async send(input: {
    readonly serializedPayload: string;
  }): Promise<PushSendOutcome> {
    this.sentPayloads.push(input.serializedPayload);
    return (
      this.outcomes.shift() ?? { kind: "delivered", statusCode: 201 }
    );
  }
}

function subscription(): PushSubscriptionRecord {
  return {
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
}

function payload() {
  return {
    version: 1 as const,
    title: "세탁기 사용 가능",
    body: "세탁기 1을 사용할 수 있습니다.",
    path: "/app/laundry",
    tag: "laundry:washer-1:transition-1",
  };
}

async function setup() {
  const subscriptions = new InMemoryPushSubscriptionStore();
  const dedupe = new InMemoryPushDedupeStore({
    retentionMs: 7 * 24 * 60 * 60 * 1000,
  });
  const sender = new FakeSender();
  await subscriptions.upsert(subscription());
  const coordinator = new PushDeliveryCoordinator({
    subscriptions,
    dedupe,
    sender,
    now: () => 1_000,
    authorizeSubscription: async () => true,
  });
  return { coordinator, dedupe, sender, subscriptions };
}

describe("PushDeliveryCoordinator", () => {
  it("sends a dedupe key once, including under concurrent delivery", async () => {
    const { coordinator, sender } = await setup();

    const results = await Promise.all([
      coordinator.deliver({
        subscriptionId: "push-1",
        dedupeKey: "jbn_same-event",
        payload: payload(),
      }),
      coordinator.deliver({
        subscriptionId: "push-1",
        dedupeKey: "jbn_same-event",
        payload: payload(),
      }),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual([
      "delivered",
      "duplicate",
    ]);
    expect(sender.sentPayloads).toHaveLength(1);
  });

  it("releases a retryable failure so a later attempt can send", async () => {
    const { coordinator, sender } = await setup();
    sender.outcomes = [
      {
        kind: "failed",
        statusCode: 503,
        reason: "provider-rejected",
        retryable: true,
      },
      { kind: "delivered", statusCode: 201 },
    ];

    await expect(
      coordinator.deliver({
        subscriptionId: "push-1",
        dedupeKey: "jbn_retryable",
        payload: payload(),
      }),
    ).resolves.toMatchObject({ status: "failed", retryable: true });
    await expect(
      coordinator.deliver({
        subscriptionId: "push-1",
        dedupeKey: "jbn_retryable",
        payload: payload(),
      }),
    ).resolves.toMatchObject({ status: "delivered" });
    expect(sender.sentPayloads).toHaveLength(2);
  });

  it.each([404, 410])(
    "revokes the subscription after a terminal HTTP %s response",
    async (statusCode) => {
      const { coordinator, sender, subscriptions } = await setup();
      sender.outcomes = [
        {
          kind: "failed",
          statusCode,
          reason: "endpoint-gone",
          retryable: false,
        },
      ];

      await expect(
        coordinator.deliver({
          subscriptionId: "push-1",
          dedupeKey: `jbn_gone-${statusCode}`,
          payload: payload(),
        }),
      ).resolves.toEqual({
        status: "subscription-revoked",
        statusCode,
      });
      await expect(
        subscriptions.findById("push-1"),
      ).resolves.toMatchObject({
        revokedAtEpochMs: 1_000,
        revokedReason: "push-endpoint-gone",
      });
    },
  );

  it("does not call the sender for an inactive subscription", async () => {
    const { coordinator, sender } = await setup();

    await expect(
      coordinator.deliver({
        subscriptionId: "missing",
        dedupeKey: "jbn_missing",
        payload: payload(),
      }),
    ).resolves.toEqual({ status: "subscription-inactive" });
    expect(sender.sentPayloads).toHaveLength(0);
  });

  it("revalidates the parent mobile session before sending", async () => {
    const subscriptions = new InMemoryPushSubscriptionStore();
    const sender = new FakeSender();
    await subscriptions.upsert(subscription());
    const coordinator = new PushDeliveryCoordinator({
      subscriptions,
      dedupe: new InMemoryPushDedupeStore({
        retentionMs: 7 * 24 * 60 * 60 * 1000,
      }),
      sender,
      now: () => 1_000,
      authorizeSubscription: async (record, nowEpochMs) => {
        expect(record).toMatchObject({
          userId: "user-1",
          deviceId: "phone-1",
        });
        expect(nowEpochMs).toBe(1_000);
        return false;
      },
    });

    await expect(
      coordinator.deliver({
        subscriptionId: "push-1",
        dedupeKey: "jbn_parent-session-revoked",
        payload: payload(),
      }),
    ).resolves.toEqual({ status: "subscription-inactive" });
    expect(sender.sentPayloads).toHaveLength(0);
    await expect(
      subscriptions.findById("push-1"),
    ).resolves.toMatchObject({
      revokedAtEpochMs: 1_000,
      revokedReason: "device-revoked",
    });
  });
});
