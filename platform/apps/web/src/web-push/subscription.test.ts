import { describe, expect, it, vi } from "vitest";

import { BrowserWebPushManager } from "./subscription";

function validVapidKey(): string {
  const bytes = validVapidKeyBytes();
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function validVapidKeyBytes(): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(65);
  bytes[0] = 4;
  bytes.fill(9, 1);
  return bytes;
}

function browserSubscription(
  applicationServerKey: ArrayBuffer | null =
    validVapidKeyBytes().buffer,
) {
  return {
    endpoint: "https://push.example.test/subscriptions/one",
    expirationTime: null,
    getKey: vi.fn(),
    options: {
      applicationServerKey,
      userVisibleOnly: true,
    },
    toJSON: () => ({
      endpoint: "https://push.example.test/subscriptions/one",
      expirationTime: null,
      keys: {
        auth: "a".repeat(22),
        p256dh: "b".repeat(87),
      },
    }),
    unsubscribe: vi.fn(async () => true),
  } satisfies PushSubscription;
}

function manager(options: {
  permission?: NotificationPermission;
  existing?: PushSubscription | null;
}) {
  const created = browserSubscription();
  const subscribe = vi.fn(async () => created);
  const getSubscription = vi.fn(async () => options.existing ?? null);
  const registration = {
    pushManager: {
      getSubscription,
      permissionState: vi.fn(),
      subscribe,
    },
  };
  const instance = new BrowserWebPushManager({
    publicVapidKey: validVapidKey(),
    getPermission: () => options.permission ?? "granted",
    serviceWorkerReady: Promise.resolve(
      registration as unknown as ServiceWorkerRegistration,
    ),
  });
  return { created, getSubscription, instance, subscribe };
}

describe("BrowserWebPushManager", () => {
  it("creates and serializes a browser push subscription", async () => {
    const { instance, subscribe } = manager({});

    await expect(instance.subscribe()).resolves.toEqual({
      endpoint: "https://push.example.test/subscriptions/one",
      expirationTime: null,
      keys: {
        auth: "a".repeat(22),
        p256dh: "b".repeat(87),
      },
    });
    expect(subscribe).toHaveBeenCalledWith({
      applicationServerKey: expect.any(Uint8Array),
      userVisibleOnly: true,
    });
  });

  it("reuses an existing subscription instead of rotating it", async () => {
    const existing = browserSubscription();
    const { instance, subscribe } = manager({ existing });

    await expect(instance.subscribe()).resolves.toMatchObject({
      endpoint: existing.endpoint,
    });
    expect(subscribe).not.toHaveBeenCalled();
    expect(existing.unsubscribe).not.toHaveBeenCalled();
  });

  it("replaces a subscription created with an old VAPID key", async () => {
    const oldKey = new Uint8Array([1, 2, 3]).buffer;
    const existing = browserSubscription(oldKey);
    const { instance, subscribe } = manager({ existing });

    await expect(instance.subscribe()).resolves.toMatchObject({
      endpoint: "https://push.example.test/subscriptions/one",
    });
    expect(existing.unsubscribe).toHaveBeenCalledOnce();
    expect(subscribe).toHaveBeenCalledOnce();
  });

  it("stops when the old VAPID subscription cannot be removed", async () => {
    const existing = browserSubscription(
      new Uint8Array([1, 2, 3]).buffer,
    );
    existing.unsubscribe.mockResolvedValue(false);
    const { instance, subscribe } = manager({ existing });

    await expect(instance.subscribe()).rejects.toEqual(
      expect.objectContaining({
        code: "VAPID_KEY_ROTATION_FAILED",
      }),
    );
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("requires permission to have been granted separately by the UI gesture", async () => {
    const { instance, subscribe } = manager({ permission: "default" });

    await expect(instance.subscribe()).rejects.toEqual(
      expect.objectContaining({
        code: "PERMISSION_NOT_GRANTED",
      }),
    );
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("unsubscribes the current browser subscription", async () => {
    const existing = browserSubscription();
    const { instance } = manager({ existing });

    await expect(instance.unsubscribe()).resolves.toBe(true);
    expect(existing.unsubscribe).toHaveBeenCalledOnce();
  });

  it("treats an already absent browser subscription as unsubscribed", async () => {
    const { instance } = manager({ existing: null });

    await expect(instance.unsubscribe()).resolves.toBe(true);
  });
});
