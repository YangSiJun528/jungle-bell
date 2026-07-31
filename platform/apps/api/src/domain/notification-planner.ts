import type { Hasher } from "./ports.js";
import type { NotificationPreferences } from "./notification-preferences.js";
import type { DeviceSessionScope } from "./pairing.js";

export type Meal = "breakfast" | "lunch" | "dinner";

export type LaundryState =
  | "AVAILABLE"
  | "BUSY"
  | "UNAVAILABLE"
  | "OFFLINE"
  | "UNKNOWN";

export type NotificationSourceEvent =
  | {
      readonly kind: "meal-published";
      readonly sourceEventId: string;
      readonly meal: Meal;
      readonly serviceDate: string;
    }
  | {
      readonly kind: "laundry-state-transition";
      readonly sourceEventId: string;
      readonly machineId: string;
      readonly previousState: LaundryState | null;
      readonly currentState: LaundryState;
    };

export interface DeviceNotificationTarget {
  readonly userId: string;
  readonly deviceId: string;
  readonly scopes: readonly (DeviceSessionScope | string)[];
  readonly revokedAtEpochMs: number | null;
  readonly preferences: NotificationPreferences;
}

export type PlannedNotification =
  | {
      readonly userId: string;
      readonly deviceId: string;
      readonly category: "meal";
      readonly dedupeKey: string;
      readonly payload: {
        readonly kind: "meal";
        readonly meal: Meal;
        readonly serviceDate: string;
      };
    }
  | {
      readonly userId: string;
      readonly deviceId: string;
      readonly category: "laundry";
      readonly dedupeKey: string;
      readonly payload: {
        readonly kind: "laundry-available";
        readonly machineId: string;
      };
    };

export class NotificationPlanner {
  constructor(
    private readonly dependencies: {
      readonly hasher: Hasher;
    },
  ) {}

  async plan(
    event: NotificationSourceEvent,
    targets: readonly DeviceNotificationTarget[],
  ): Promise<readonly PlannedNotification[]> {
    const eligibleTargets = targets.filter((target) =>
      isEligibleTarget(target),
    );

    if (event.kind === "meal-published") {
      return Promise.all(
        eligibleTargets
          .filter((target) => target.preferences.meals[event.meal])
          .map(async (target): Promise<PlannedNotification> => ({
            userId: target.userId,
            deviceId: target.deviceId,
            category: "meal",
            dedupeKey: await this.dedupeKey([
              "notification",
              "v1",
              "meal",
              target.userId,
              target.deviceId,
              event.serviceDate,
              event.meal,
            ]),
            payload: {
              kind: "meal",
              meal: event.meal,
              serviceDate: event.serviceDate,
            },
          })),
      );
    }

    if (!isConfirmedAvailableTransition(event)) {
      return [];
    }

    return Promise.all(
      eligibleTargets
        .filter(
          (target) =>
            target.preferences.laundry.notifyWhenAvailable &&
            target.preferences.laundry.selectedMachineIds.includes(
              event.machineId,
            ),
        )
        .map(async (target): Promise<PlannedNotification> => ({
          userId: target.userId,
          deviceId: target.deviceId,
          category: "laundry",
          dedupeKey: await this.dedupeKey([
            "notification",
            "v1",
            "laundry-available",
            target.userId,
            target.deviceId,
            event.machineId,
            event.sourceEventId,
          ]),
          payload: {
            kind: "laundry-available",
            machineId: event.machineId,
          },
        })),
    );
  }

  private async dedupeKey(parts: readonly string[]): Promise<string> {
    const digest = await this.dependencies.hasher.hash(JSON.stringify(parts));
    return `jbn_${digest}`;
  }
}

function isEligibleTarget(target: DeviceNotificationTarget): boolean {
  return (
    target.revokedAtEpochMs === null &&
    target.scopes.includes("notifications:receive") &&
    target.preferences.userId === target.userId &&
    target.preferences.deviceId === target.deviceId
  );
}

function isConfirmedAvailableTransition(
  event: Extract<
    NotificationSourceEvent,
    { readonly kind: "laundry-state-transition" }
  >,
): boolean {
  return (
    event.currentState === "AVAILABLE" &&
    (event.previousState === "BUSY" ||
      event.previousState === "UNAVAILABLE")
  );
}
