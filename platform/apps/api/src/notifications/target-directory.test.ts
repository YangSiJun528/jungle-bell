import { describe, expect, it, vi } from "vitest";

import { StoreBackedNotificationTargetDirectory } from "./target-directory.js";

describe("StoreBackedNotificationTargetDirectory", () => {
  it("fans a user notification out to every registered PC and active PWA subscription", async () => {
    const listDesktopDevices = vi.fn(async () => [
      desktop("user-1", "desktop-a"),
      desktop("user-1", "desktop-b"),
      desktop("other-user", "foreign-desktop"),
    ]);
    const listActiveByUserId = vi.fn(async () => [
      subscription("user-1", "phone-a", "push-a", null),
      subscription("user-1", "phone-b", "push-b", 123),
      subscription("other-user", "phone-c", "push-c", null),
    ]);
    const listDeviceSessions = vi.fn(async () => [
      mobileSession("user-1", "phone-a", null, 1),
      mobileSession("user-1", "phone-b", 123, 1),
    ]);
    const directory = new StoreBackedNotificationTargetDirectory({
      desktopIdentities: { listDesktopDevices },
      desktopSessions: {
        hasActiveForDevice: async () => true,
      },
      deviceSessions: { listDeviceSessions },
      pushSubscriptions: { listActiveByUserId },
      webPushEnabled: true,
      now: () => 1_000,
    });

    await expect(directory.listTargets("user-1")).resolves.toEqual([
      {
        userId: "user-1",
        deviceId: "desktop-a",
        channel: "desktop",
        destinationId: "desktop-a",
        enabled: true,
      },
      {
        userId: "user-1",
        deviceId: "desktop-b",
        channel: "desktop",
        destinationId: "desktop-b",
        enabled: true,
      },
      {
        userId: "user-1",
        deviceId: "phone-a",
        channel: "web-push",
        destinationId: "push-a",
        enabled: true,
      },
    ]);
  });

  it("does not resolve push targets when VAPID delivery is unavailable", async () => {
    const listActiveByUserId = vi.fn(async () => [
      subscription("user-1", "phone-a", "push-a", null),
    ]);
    const directory = new StoreBackedNotificationTargetDirectory({
      desktopIdentities: {
        listDesktopDevices: async () => [desktop("user-1", "desktop-a")],
      },
      desktopSessions: {
        hasActiveForDevice: async () => true,
      },
      deviceSessions: { listDeviceSessions: async () => [] },
      pushSubscriptions: { listActiveByUserId },
      webPushEnabled: false,
      now: () => 1_000,
    });

    await expect(directory.listTargets("user-1")).resolves.toEqual([
      {
        userId: "user-1",
        deviceId: "desktop-a",
        channel: "desktop",
        destinationId: "desktop-a",
        enabled: true,
      },
    ]);
    expect(listActiveByUserId).not.toHaveBeenCalled();
  });

  it("keeps offline PCs with an active app session and excludes invalid sessions", async () => {
    const directory = new StoreBackedNotificationTargetDirectory({
      desktopIdentities: {
        listDesktopDevices: async () => [
          { ...desktop("user-1", "fresh"), lastSeenAtEpochMs: 9_900 },
          { ...desktop("user-1", "offline"), lastSeenAtEpochMs: 1 },
          { ...desktop("user-1", "signed-out"), lastSeenAtEpochMs: 1 },
          {
            ...desktop("user-1", "login-required"),
            lastSeenAtEpochMs: 9_900,
            lmsSessionState: "login-required",
          },
        ],
      },
      desktopSessions: {
        hasActiveForDevice: async ({ desktopDeviceId }) =>
          desktopDeviceId !== "signed-out",
      },
      deviceSessions: {
        listDeviceSessions: async () => [
          mobileSession("user-1", "active", null, 9_000),
          mobileSession("user-1", "revoked", 9_500, 9_000),
          mobileSession("user-1", "expired", null, 1),
        ],
      },
      pushSubscriptions: {
        listActiveByUserId: async () => [
          subscription("user-1", "active", "push-active", null),
          subscription("user-1", "revoked", "push-revoked", null),
          subscription("user-1", "expired", "push-expired", null),
          subscription("user-1", "orphan", "push-orphan", null),
        ],
      },
      webPushEnabled: true,
      now: () => 10_000,
      mobileSessionTtlMs: 5_000,
    });

    await expect(directory.listTargets("user-1")).resolves.toEqual([
      {
        userId: "user-1",
        deviceId: "fresh",
        channel: "desktop",
        destinationId: "fresh",
        enabled: true,
      },
      {
        userId: "user-1",
        deviceId: "offline",
        channel: "desktop",
        destinationId: "offline",
        enabled: true,
      },
      {
        userId: "user-1",
        deviceId: "login-required",
        channel: "desktop",
        destinationId: "login-required",
        enabled: true,
      },
      {
        userId: "user-1",
        deviceId: "active",
        channel: "web-push",
        destinationId: "push-active",
        enabled: true,
      },
    ]);
  });
});

function desktop(userId: string, desktopDeviceId: string) {
  return {
    userId,
    desktopDeviceId,
    registeredAtEpochMs: 1,
    lastVerifiedAtEpochMs: 1,
    lastSeenAtEpochMs: 1_000,
    lmsSessionState: "connected" as const,
    appVersion: null,
  };
}

function mobileSession(
  userId: string,
  deviceId: string,
  revokedAtEpochMs: number | null,
  createdAtEpochMs: number,
) {
  return {
    sessionId: `session-${deviceId}`,
    userId,
    deviceId,
    deviceLabel: deviceId,
    installationId: `jbmi_${deviceId
      .length.toString(16)
      .padStart(32, "0")}`,
    tokenHash: `hash-${deviceId}`,
    scopes: ["notifications:receive"] as const,
    createdAtEpochMs,
    revokedAtEpochMs,
    version: revokedAtEpochMs === null ? 0 : 1,
  };
}

function subscription(
  userId: string,
  deviceId: string,
  id: string,
  revokedAtEpochMs: number | null,
) {
  return {
    id,
    userId,
    deviceId,
    subscription: {
      endpoint: `https://push.example/${id}`,
      expirationTime: null,
      keys: { p256dh: "key", auth: "auth" },
    },
    createdAtEpochMs: 1,
    updatedAtEpochMs: 1,
    revokedAtEpochMs,
    revokedReason:
      revokedAtEpochMs === null
        ? null
        : ("user-unsubscribed" as const),
  };
}
