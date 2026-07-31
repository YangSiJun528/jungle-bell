import { describe, expect, it } from "vitest";
import type { Hasher } from "./ports";
import type { NotificationPreferences } from "./notification-preferences";
import {
  NotificationPlanner,
  type DeviceNotificationTarget,
} from "./notification-planner";

class TestHasher implements Hasher {
  async hash(value: string): Promise<string> {
    let result = 0;
    for (const character of value) {
      result = (Math.imul(result, 31) + character.charCodeAt(0)) >>> 0;
    }
    return result.toString(16).padStart(8, "0");
  }
}

function preferences(
  overrides: Partial<NotificationPreferences> = {},
): NotificationPreferences {
  return {
    userId: "user-1",
    deviceId: "phone-1",
    meals: {
      breakfast: false,
      lunch: true,
      dinner: false,
    },
    laundry: {
      notifyWhenAvailable: true,
      selectedMachineIds: ["washer-1"],
    },
    updatedAtEpochMs: 0,
    ...overrides,
  };
}

function target(
  overrides: Partial<DeviceNotificationTarget> = {},
): DeviceNotificationTarget {
  const value = preferences();
  return {
    userId: value.userId,
    deviceId: value.deviceId,
    scopes: ["notifications:receive"],
    revokedAtEpochMs: null,
    preferences: value,
    ...overrides,
  };
}

describe("NotificationPlanner", () => {
  it("plans enabled meal notifications only for active scoped devices", async () => {
    const planner = new NotificationPlanner({ hasher: new TestHasher() });
    const enabled = target();
    const disabled = target({
      deviceId: "phone-2",
      preferences: preferences({
        deviceId: "phone-2",
        meals: {
          breakfast: false,
          lunch: false,
          dinner: false,
        },
      }),
    });
    const revoked = target({
      deviceId: "phone-3",
      revokedAtEpochMs: 123,
      preferences: preferences({ deviceId: "phone-3" }),
    });
    const missingScope = target({
      deviceId: "phone-4",
      scopes: ["preferences:write"],
      preferences: preferences({ deviceId: "phone-4" }),
    });

    const plans = await planner.plan(
      {
        kind: "meal-published",
        sourceEventId: "source-a",
        meal: "lunch",
        serviceDate: "2026-07-30",
      },
      [enabled, disabled, revoked, missingScope],
    );

    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({
      userId: "user-1",
      deviceId: "phone-1",
      category: "meal",
      payload: {
        kind: "meal",
        meal: "lunch",
        serviceDate: "2026-07-30",
      },
    });
  });

  it("uses a stable per-device meal dedupe key for the same meal and day", async () => {
    const planner = new NotificationPlanner({ hasher: new TestHasher() });
    const first = await planner.plan(
      {
        kind: "meal-published",
        sourceEventId: "collector-event-1",
        meal: "lunch",
        serviceDate: "2026-07-30",
      },
      [target()],
    );
    const replayFromAnotherCollectorEvent = await planner.plan(
      {
        kind: "meal-published",
        sourceEventId: "collector-event-2",
        meal: "lunch",
        serviceDate: "2026-07-30",
      },
      [target()],
    );
    const anotherDevice = await planner.plan(
      {
        kind: "meal-published",
        sourceEventId: "collector-event-2",
        meal: "lunch",
        serviceDate: "2026-07-30",
      },
      [
        target({
          deviceId: "phone-2",
          preferences: preferences({ deviceId: "phone-2" }),
        }),
      ],
    );

    expect(first[0]?.dedupeKey).toBe(
      replayFromAnotherCollectorEvent[0]?.dedupeKey,
    );
    expect(first[0]?.dedupeKey).not.toBe(anotherDevice[0]?.dedupeKey);
  });

  it("notifies only a selected machine's confirmed unavailable-to-available transition", async () => {
    const planner = new NotificationPlanner({ hasher: new TestHasher() });
    const recipient = target();

    const planned = await planner.plan(
      {
        kind: "laundry-state-transition",
        sourceEventId: "transition-1",
        machineId: "washer-1",
        previousState: "BUSY",
        currentState: "AVAILABLE",
      },
      [recipient],
    );
    const replay = await planner.plan(
      {
        kind: "laundry-state-transition",
        sourceEventId: "transition-1",
        machineId: "washer-1",
        previousState: "BUSY",
        currentState: "AVAILABLE",
      },
      [recipient],
    );
    const nextCycle = await planner.plan(
      {
        kind: "laundry-state-transition",
        sourceEventId: "transition-2",
        machineId: "washer-1",
        previousState: "BUSY",
        currentState: "AVAILABLE",
      },
      [recipient],
    );

    expect(planned).toHaveLength(1);
    expect(planned[0]).toMatchObject({
      category: "laundry",
      payload: {
        kind: "laundry-available",
        machineId: "washer-1",
      },
    });
    expect(replay[0]?.dedupeKey).toBe(planned[0]?.dedupeKey);
    expect(nextCycle[0]?.dedupeKey).not.toBe(planned[0]?.dedupeKey);

    for (const event of [
      {
        kind: "laundry-state-transition" as const,
        sourceEventId: "initial",
        machineId: "washer-1",
        previousState: null,
        currentState: "AVAILABLE" as const,
      },
      {
        kind: "laundry-state-transition" as const,
        sourceEventId: "repeat",
        machineId: "washer-1",
        previousState: "AVAILABLE" as const,
        currentState: "AVAILABLE" as const,
      },
      {
        kind: "laundry-state-transition" as const,
        sourceEventId: "reconnected",
        machineId: "washer-1",
        previousState: "OFFLINE" as const,
        currentState: "AVAILABLE" as const,
      },
      {
        kind: "laundry-state-transition" as const,
        sourceEventId: "unselected",
        machineId: "washer-2",
        previousState: "BUSY" as const,
        currentState: "AVAILABLE" as const,
      },
    ]) {
      await expect(planner.plan(event, [recipient])).resolves.toEqual([]);
    }
  });
});
