import type { RenewalStore } from "@jungle-bell/backend-common/ports/account-storage";
import { sha256Hex } from "@jungle-bell/backend-common/renewal/crypto";
import type { Principal } from "../domain/session";

export type PushSubscriptionStore = Pick<RenewalStore, "revokePushSubscription" | "upsertPushSubscription">;

export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** Browser Push subscription workflows; VAPID transport remains a Jobs concern. */
export class PushService {
  constructor(private readonly store: PushSubscriptionStore) {}

  async subscribe(principal: Principal, input: PushSubscriptionInput, nowEpochMs: number) {
    const id = `jbps_${await sha256Hex(input.endpoint)}`;
    await this.store.upsertPushSubscription({
      id,
      userId: principal.userId,
      sessionId: principal.sessionId,
      endpoint: input.endpoint,
      p256dh: input.keys.p256dh,
      auth: input.keys.auth,
      createdAtEpochMs: nowEpochMs,
      revokedAtEpochMs: null,
    });
    return { subscriptionId: id };
  }

  unsubscribe(userId: string, subscriptionId: string, nowEpochMs: number): Promise<boolean> {
    return this.store.revokePushSubscription(userId, subscriptionId, nowEpochMs);
  }
}
