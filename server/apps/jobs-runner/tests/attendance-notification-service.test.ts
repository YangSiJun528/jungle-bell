import { describe, expect, it } from "vitest";
import {
  planAttendanceNotifications,
  type AttendanceNotificationStore,
} from "../src/services/attendance-notification-service";
import type {
  AttendancePreferenceRecord,
  NotificationRecord,
} from "@jungle-bell/backend-common/ports/account-storage";

const PREFERENCE: AttendancePreferenceRecord = {
  enabled: true,
  morning: true,
  evening: true,
  morningStartHour: 4,
  eveningEndHour: 4,
  morningIntervalMinutes: 15,
  eveningIntervalMinutes: 15,
  skipSunday: false,
  skipAttendanceDate: null,
};

describe("attendance notification planning concurrency", () => {
  it("limits D1 gateway work to eight users across overlapping phases", async () => {
    const userIds = Array.from({ length: 25 }, (_, index) => `user-${index}`);
    const notificationKeys = new Set<string>();
    let inFlight = 0;
    let maxInFlight = 0;

    const store = {
      async listAttendanceSubscriberUserIds() {
        return userIds;
      },
      async getAttendancePreference() {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;
        return PREFERENCE;
      },
      async getLatestAttendanceSnapshot() {
        return null;
      },
      async listDesktopDevices() {
        return [];
      },
      async insertNotification(notification: NotificationRecord) {
        const key = `${notification.userId}:${notification.sourceEventId}`;
        if (notificationKeys.has(key)) return false;
        notificationKeys.add(key);
        return true;
      },
    } satisfies AttendanceNotificationStore;

    const created = await planAttendanceNotifications(
      store,
      Date.parse("2026-08-03T19:05:00.000Z"),
    );

    expect(created).toBe(50);
    expect(notificationKeys).toHaveLength(50);
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(8);
  });
});
