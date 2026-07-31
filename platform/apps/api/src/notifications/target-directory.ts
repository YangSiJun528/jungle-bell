import type {
  DesktopIdentityStore,
  DesktopSessionStore,
} from "../infra/sqlite/index.js";
import {
  DEFAULT_DEVICE_SESSION_TTL_MS,
  type PairingStore,
} from "../domain/pairing.js";
import type { PushSubscriptionStore } from "../push/index.js";
import type {
  NotificationTarget,
  NotificationTargetDirectory,
} from "./contracts.js";

export class StoreBackedNotificationTargetDirectory
  implements NotificationTargetDirectory
{
  constructor(
    private readonly dependencies: {
      readonly desktopIdentities: Pick<
        DesktopIdentityStore,
        "listDesktopDevices"
      >;
      readonly desktopSessions: Pick<
        DesktopSessionStore,
        "hasActiveForDevice"
      >;
      readonly deviceSessions: Pick<
        PairingStore,
        "listDeviceSessions"
      >;
      readonly pushSubscriptions: Pick<
        PushSubscriptionStore,
        "listActiveByUserId"
      >;
      readonly webPushEnabled: boolean;
      readonly now?: () => number;
      readonly mobileSessionTtlMs?: number;
    },
  ) {}

  async listTargets(
    userId: string,
  ): Promise<readonly NotificationTarget[]> {
    const nowEpochMs = this.dependencies.now?.() ?? Date.now();
    const mobileSessionTtlMs =
      this.dependencies.mobileSessionTtlMs ??
      DEFAULT_DEVICE_SESSION_TTL_MS;
    const desktopDevices =
      await this.dependencies.desktopIdentities.listDesktopDevices(userId);
    const pushSubscriptions = this.dependencies.webPushEnabled
      ? await this.dependencies.pushSubscriptions.listActiveByUserId(
          userId,
        )
      : [];
    const validMobileDeviceIds = this.dependencies.webPushEnabled
      ? new Set(
          (
            await this.dependencies.deviceSessions.listDeviceSessions(
              userId,
            )
          )
            .filter(
              (session) =>
                session.userId === userId &&
                session.revokedAtEpochMs === null &&
                session.createdAtEpochMs + mobileSessionTtlMs >
                  nowEpochMs,
            )
            .map((session) => session.deviceId),
        )
      : new Set<string>();
    const targets: NotificationTarget[] = [];
    const seen = new Set<string>();

    for (const device of desktopDevices) {
      if (
        device.userId !== userId ||
        !(await this.dependencies.desktopSessions.hasActiveForDevice({
          userId,
          desktopDeviceId: device.desktopDeviceId,
          nowEpochMs,
        }))
      ) {
        continue;
      }
      appendUnique(targets, seen, {
        userId,
        deviceId: device.desktopDeviceId,
        channel: "desktop",
        destinationId: device.desktopDeviceId,
        enabled: true,
      });
    }
    for (const subscription of pushSubscriptions) {
      if (
        subscription.userId !== userId ||
        subscription.revokedAtEpochMs !== null ||
        !validMobileDeviceIds.has(subscription.deviceId) ||
        (subscription.subscription.expirationTime !== null &&
          subscription.subscription.expirationTime <= nowEpochMs)
      ) {
        continue;
      }
      appendUnique(targets, seen, {
        userId,
        deviceId: subscription.deviceId,
        channel: "web-push",
        destinationId: subscription.id,
        enabled: true,
      });
    }
    return targets;
  }
}

function appendUnique(
  targets: NotificationTarget[],
  seen: Set<string>,
  target: NotificationTarget,
): void {
  const key = `${target.channel}\u0000${target.destinationId}`;
  if (seen.has(key)) return;
  seen.add(key);
  targets.push(target);
}
