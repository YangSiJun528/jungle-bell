import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearBrowserPushState,
  readStoredPushSubscriptionId,
  storePushSubscriptionId,
} from "./push-local-state";

const subscriptionId = `jbps_${"a".repeat(64)}`;

describe("local browser Push state", () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
        clear: () => values.clear(),
      },
    });
  });

  it("stores only strict opaque subscription identifiers", () => {
    storePushSubscriptionId(subscriptionId);
    expect(readStoredPushSubscriptionId()).toBe(subscriptionId);
    expect(() =>
      storePushSubscriptionId("previous-user-subscription"),
    ).toThrow("PUSH_SUBSCRIPTION_ID_INVALID");
  });

  it("unsubscribes and clears stale ownership during re-pairing", async () => {
    const unsubscribe = vi.fn(async () => true);
    storePushSubscriptionId(subscriptionId);
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        getRegistration: vi.fn(async () => ({
          pushManager: {
            getSubscription: vi.fn(async () => ({ unsubscribe })),
          },
        })),
      },
    });

    await expect(clearBrowserPushState()).resolves.toBe(true);
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(readStoredPushSubscriptionId()).toBeNull();
  });

  it("clears stale local ownership even when browser unsubscribe fails", async () => {
    storePushSubscriptionId(subscriptionId);
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        getRegistration: vi.fn(async () => ({
          pushManager: {
            getSubscription: vi.fn(async () => ({
              unsubscribe: vi.fn(async () => {
                throw new Error("browser failure");
              }),
            })),
          },
        })),
      },
    });

    await expect(clearBrowserPushState()).resolves.toBe(false);
    expect(readStoredPushSubscriptionId()).toBeNull();
  });
});
