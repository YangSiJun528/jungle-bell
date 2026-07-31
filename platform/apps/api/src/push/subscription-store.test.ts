import { describe, expect, it } from "vitest";

import {
  InMemoryPushSubscriptionStore,
  type PushSubscriptionRecord,
} from "./subscription-store";

function record(
  overrides: Partial<PushSubscriptionRecord> = {},
): PushSubscriptionRecord {
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
    createdAtEpochMs: 100,
    updatedAtEpochMs: 100,
    revokedAtEpochMs: null,
    revokedReason: null,
    ...overrides,
  };
}

describe("InMemoryPushSubscriptionStore", () => {
  it("upserts and lists only active subscriptions", async () => {
    const store = new InMemoryPushSubscriptionStore();
    await store.upsert(record());
    await store.upsert(
      record({
        id: "push-2",
        deviceId: "phone-2",
        subscription: {
          endpoint: "https://updates.push.services.mozilla.com/wpush/two",
          expirationTime: null,
          keys: {
            auth: "c".repeat(22),
            p256dh: "d".repeat(87),
          },
        },
      }),
    );

    await store.revoke("push-2", {
      atEpochMs: 200,
      reason: "user-unsubscribed",
    });

    await expect(store.listActiveByUserId("user-1")).resolves.toEqual([
      record(),
    ]);
    await expect(store.findActiveById("push-2")).resolves.toBeUndefined();
    await expect(store.findById("push-2")).resolves.toMatchObject({
      revokedAtEpochMs: 200,
      revokedReason: "user-unsubscribed",
    });
  });

  it("returns defensive copies", async () => {
    const store = new InMemoryPushSubscriptionStore();
    const original = record();
    await store.upsert(original);

    const loaded = await store.findById(original.id);
    if (!loaded) {
      throw new Error("expected record");
    }
    loaded.subscription.keys.auth = "mutated";

    await expect(store.findById(original.id)).resolves.toEqual(original);
  });
});
