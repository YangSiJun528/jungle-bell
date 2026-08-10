import webPush from "web-push";
import { createECDH, timingSafeEqual } from "node:crypto";
import { isAllowedBrowserPushEndpoint, type PushSender } from "../renewal/push-sender";
import type { PushDeliveryRecord } from "../workers/account-storage";

const MAX_WEB_PUSH_TTL_SECONDS = 24 * 60 * 60;

export interface NodeWebPushConfiguration {
  subject: string;
  publicKey: string;
  privateKey: string;
}

interface WebPushTransport {
  sendNotification(
    subscription: webPush.PushSubscription,
    payload: string,
    options: webPush.RequestOptions,
  ): Promise<webPush.SendResult>;
}

function providerStatus(error: unknown): number | null {
  if (!error || typeof error !== "object" || !("statusCode" in error)) return null;
  const status = (error as { statusCode?: unknown }).statusCode;
  return typeof status === "number" && Number.isInteger(status) ? status : null;
}

export class NodeWebPushSender implements PushSender {
  constructor(
    private readonly configuration: NodeWebPushConfiguration,
    private readonly transport: WebPushTransport = webPush,
  ) {
    try {
      webPush.setVapidDetails(configuration.subject, configuration.publicKey, configuration.privateKey);
      const keyPair = createECDH("prime256v1");
      keyPair.setPrivateKey(Buffer.from(configuration.privateKey, "base64url"));
      const suppliedPublicKey = Buffer.from(configuration.publicKey, "base64url");
      if (!timingSafeEqual(keyPair.getPublicKey(), suppliedPublicKey)) {
        throw new Error("VAPID public/private keys do not match");
      }
    } catch (error) {
      throw new Error("VAPID_CONFIGURATION_INVALID", { cause: error });
    }
  }

  async send(
    delivery: PushDeliveryRecord,
    nowEpochMs: number,
  ): Promise<{ status: "delivered" | "retry" | "gone"; error: string | null }> {
    if (!isAllowedBrowserPushEndpoint(delivery.subscription.endpoint)) {
      return { status: "gone", error: "INVALID_PUSH_ENDPOINT" };
    }
    try {
      await this.transport.sendNotification(
        {
          endpoint: delivery.subscription.endpoint,
          keys: {
            p256dh: delivery.subscription.p256dh,
            auth: delivery.subscription.auth,
          },
        },
        delivery.payloadJson,
        {
          TTL: Math.max(0, Math.min(MAX_WEB_PUSH_TTL_SECONDS,
            Math.ceil((delivery.expiresAtEpochMs - nowEpochMs) / 1_000))),
          urgency: "high",
          timeout: 10_000,
          vapidDetails: {
            subject: this.configuration.subject,
            publicKey: this.configuration.publicKey,
            privateKey: this.configuration.privateKey,
          },
        },
      );
      return { status: "delivered", error: null };
    } catch (error) {
      const status = providerStatus(error);
      if (status === 404 || status === 410) return { status: "gone", error: `HTTP_${status}` };
      return { status: "retry", error: status === null ? "WEB_PUSH_NETWORK_ERROR" : `HTTP_${status}` };
    }
  }
}
