import { describe, expect, it, vi } from "vitest";

import {
  detectWebPushCapability,
  requestWebPushPermissionFromUserGesture,
  type WebPushEnvironment,
} from "./capability";

function environment(
  overrides: Partial<WebPushEnvironment> = {},
): WebPushEnvironment {
  return {
    isSecureContext: true,
    isStandalone: true,
    hasServiceWorker: true,
    hasPushManager: true,
    notificationPermission: "default",
    userActivationIsActive: true,
    requestNotificationPermission: vi.fn(
      async (): Promise<NotificationPermission> => "granted",
    ),
    ...overrides,
  };
}

describe("detectWebPushCapability", () => {
  it("reports an installed, secure and supported PWA as eligible", () => {
    expect(detectWebPushCapability(environment())).toEqual({
      eligible: true,
      installed: true,
      permission: "default",
      reason: null,
      supported: true,
    });
  });

  it.each([
    [{ isSecureContext: false }, "INSECURE_CONTEXT"],
    [{ isStandalone: false }, "PWA_INSTALL_REQUIRED"],
    [{ hasServiceWorker: false }, "UNSUPPORTED"],
    [{ hasPushManager: false }, "UNSUPPORTED"],
  ] as const)("reports an explicit ineligible reason", (overrides, reason) => {
    expect(
      detectWebPushCapability(environment(overrides)),
    ).toMatchObject({
      eligible: false,
      reason,
    });
  });
});

describe("requestWebPushPermissionFromUserGesture", () => {
  it("requests permission only while transient user activation is active", async () => {
    const requestNotificationPermission = vi.fn(async () => "granted" as const);

    await expect(
      requestWebPushPermissionFromUserGesture(
        environment({ requestNotificationPermission }),
      ),
    ).resolves.toBe("granted");
    expect(requestNotificationPermission).toHaveBeenCalledOnce();
  });

  it("rejects calls made outside a user gesture without opening a prompt", async () => {
    const requestNotificationPermission = vi.fn(async () => "granted" as const);

    await expect(
      requestWebPushPermissionFromUserGesture(
        environment({
          requestNotificationPermission,
          userActivationIsActive: false,
        }),
      ),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "USER_GESTURE_REQUIRED",
      }),
    );
    expect(requestNotificationPermission).not.toHaveBeenCalled();
  });

  it("does not re-prompt after permission was denied", async () => {
    const requestNotificationPermission = vi.fn(async () => "granted" as const);

    await expect(
      requestWebPushPermissionFromUserGesture(
        environment({
          notificationPermission: "denied",
          requestNotificationPermission,
        }),
      ),
    ).resolves.toBe("denied");
    expect(requestNotificationPermission).not.toHaveBeenCalled();
  });

  it.each([
    [{ isSecureContext: false }, "INSECURE_CONTEXT"],
    [{ isStandalone: false }, "PWA_INSTALL_REQUIRED"],
    [{ hasServiceWorker: false }, "UNSUPPORTED"],
    [{ hasPushManager: false }, "UNSUPPORTED"],
  ] as const)(
    "does not let an existing grant bypass capability checks",
    async (overrides, code) => {
      const requestNotificationPermission = vi.fn(
        async () => "granted" as const,
      );

      await expect(
        requestWebPushPermissionFromUserGesture(
          environment({
            ...overrides,
            notificationPermission: "granted",
            requestNotificationPermission,
          }),
        ),
      ).rejects.toEqual(expect.objectContaining({ code }));
      expect(requestNotificationPermission).not.toHaveBeenCalled();
    },
  );
});
