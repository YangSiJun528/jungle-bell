import { vapidPublicKeyToApplicationServerKey } from "./vapid.js";

const BASE64_URL_PATTERN = /^[A-Za-z0-9_-]+={0,2}$/u;

export interface BrowserPushSubscriptionDto {
  readonly endpoint: string;
  readonly expirationTime: number | null;
  readonly keys: {
    readonly auth: string;
    readonly p256dh: string;
  };
}

export type WebPushSubscriptionErrorCode =
  | "INVALID_BROWSER_SUBSCRIPTION"
  | "PERMISSION_NOT_GRANTED"
  | "VAPID_KEY_ROTATION_FAILED";

export class WebPushSubscriptionError extends Error {
  constructor(
    readonly code: WebPushSubscriptionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WebPushSubscriptionError";
  }
}

export class BrowserWebPushManager {
  private readonly applicationServerKey: Uint8Array<ArrayBuffer>;

  constructor(
    private readonly dependencies: {
      readonly publicVapidKey: string;
      readonly getPermission: () => NotificationPermission;
      readonly serviceWorkerReady: Promise<ServiceWorkerRegistration>;
    },
  ) {
    this.applicationServerKey = vapidPublicKeyToApplicationServerKey(
      dependencies.publicVapidKey,
    );
  }

  async subscribe(): Promise<BrowserPushSubscriptionDto> {
    if (this.dependencies.getPermission() !== "granted") {
      throw new WebPushSubscriptionError(
        "PERMISSION_NOT_GRANTED",
        "Request notification permission from a user gesture first.",
      );
    }

    const registration = await this.dependencies.serviceWorkerReady;
    let existing = await registration.pushManager.getSubscription();
    if (
      existing !== null &&
      !sameApplicationServerKey(
        existing.options.applicationServerKey,
        this.applicationServerKey,
      )
    ) {
      const removed = await existing.unsubscribe();
      if (!removed) {
        throw new WebPushSubscriptionError(
          "VAPID_KEY_ROTATION_FAILED",
          "The previous Push subscription could not be removed.",
        );
      }
      existing = null;
    }
    const subscription =
      existing ??
      (await registration.pushManager.subscribe({
        applicationServerKey: this.applicationServerKey,
        userVisibleOnly: true,
      }));
    return serializeBrowserSubscription(subscription);
  }

  async unsubscribe(): Promise<boolean> {
    const registration = await this.dependencies.serviceWorkerReady;
    const existing = await registration.pushManager.getSubscription();
    if (!existing) {
      return true;
    }
    return existing.unsubscribe();
  }
}

function sameApplicationServerKey(
  current: ArrayBuffer | null,
  expected: Uint8Array<ArrayBuffer>,
): boolean {
  if (current === null) {
    return false;
  }
  const currentBytes = new Uint8Array(current);
  return (
    currentBytes.length === expected.length &&
    currentBytes.every((byte, index) => byte === expected[index])
  );
}

export function serializeBrowserSubscription(
  subscription: PushSubscription,
): BrowserPushSubscriptionDto {
  const serialized = subscription.toJSON();
  if (
    typeof serialized.endpoint !== "string" ||
    typeof serialized.keys?.auth !== "string" ||
    typeof serialized.keys.p256dh !== "string" ||
    !isValidPushEndpoint(serialized.endpoint) ||
    !isValidBase64UrlKey(serialized.keys.auth, 16, 256) ||
    !isValidBase64UrlKey(serialized.keys.p256dh, 32, 512) ||
    (serialized.expirationTime !== null &&
      serialized.expirationTime !== undefined &&
      (!Number.isSafeInteger(serialized.expirationTime) ||
        serialized.expirationTime < 0))
  ) {
    throw new WebPushSubscriptionError(
      "INVALID_BROWSER_SUBSCRIPTION",
      "Browser returned an invalid PushSubscription.",
    );
  }

  return {
    endpoint: serialized.endpoint,
    expirationTime: serialized.expirationTime ?? null,
    keys: {
      auth: serialized.keys.auth,
      p256dh: serialized.keys.p256dh,
    },
  };
}

function isValidPushEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      value.length <= 2_048
    );
  } catch {
    return false;
  }
}

function isValidBase64UrlKey(
  value: string,
  minimumLength: number,
  maximumLength: number,
): boolean {
  return (
    value.length >= minimumLength &&
    value.length <= maximumLength &&
    BASE64_URL_PATTERN.test(value)
  );
}
