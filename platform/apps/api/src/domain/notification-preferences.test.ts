import { describe, expect, it } from "vitest";
import type { Clock } from "./ports";
import {
  InMemoryNotificationPreferenceStore,
  NotificationPreferenceService,
} from "./notification-preferences";

class TestClock implements Clock {
  constructor(private value: number) {}

  now(): number {
    return this.value;
  }

  advance(milliseconds: number): void {
    this.value += milliseconds;
  }
}

describe("NotificationPreferenceService", () => {
  it("keeps meal and laundry preferences independently per user and device", async () => {
    const clock = new TestClock(Date.parse("2026-07-30T00:00:00.000Z"));
    const store = new InMemoryNotificationPreferenceStore();
    const service = new NotificationPreferenceService({ clock, store });

    const phone = await service.put({
      userId: "user-1",
      deviceId: "phone-1",
      meals: {
        breakfast: true,
        lunch: false,
        dinner: true,
      },
      laundry: {
        notifyWhenAvailable: true,
        selectedMachineIds: ["washer-b", "washer-a", "washer-b"],
      },
    });
    clock.advance(1_000);
    const tablet = await service.put({
      userId: "user-1",
      deviceId: "tablet-1",
      meals: {
        breakfast: false,
        lunch: true,
        dinner: false,
      },
      laundry: {
        notifyWhenAvailable: false,
        selectedMachineIds: [],
      },
    });

    expect(phone.laundry.selectedMachineIds).toEqual(["washer-a", "washer-b"]);
    expect(phone.updatedAtEpochMs).toBeLessThan(tablet.updatedAtEpochMs);
    expect(await service.get("user-1", "phone-1")).toEqual(phone);
    expect(await service.get("user-1", "tablet-1")).toEqual(tablet);
    expect(await service.get("user-2", "phone-1")).toMatchObject({
      userId: "user-2",
      deviceId: "phone-1",
      meals: {
        breakfast: false,
        lunch: false,
        dinner: false,
      },
      laundry: {
        notifyWhenAvailable: false,
        selectedMachineIds: [],
      },
    });
  });

  it("rejects malformed identifiers and machine selections", async () => {
    const service = new NotificationPreferenceService({
      clock: new TestClock(0),
      store: new InMemoryNotificationPreferenceStore(),
    });

    await expect(
      service.put({
        userId: "user-1",
        deviceId: "phone-1",
        meals: {
          breakfast: false,
          lunch: false,
          dinner: false,
        },
        laundry: {
          notifyWhenAvailable: true,
          selectedMachineIds: ["  "],
        },
      }),
    ).rejects.toMatchObject({ code: "INVALID_NOTIFICATION_PREFERENCES" });
  });
});
