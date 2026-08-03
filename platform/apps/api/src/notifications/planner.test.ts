import { describe, expect, it } from "vitest";

import type {
  LaundryQueueEntry,
  LaundryWatch,
} from "../campus/contracts.js";
import type {
  NotificationRuleReader,
} from "./contracts.js";
import { ServerNotificationPlanner } from "./planner.js";

describe("ServerNotificationPlanner", () => {
  it("plans meal notifications once per subscribed user, not per device", () => {
    const planner = new ServerNotificationPlanner(
      rules({ mealUsers: ["user-1", "user-2"] }),
    );

    const planned = planner.plan({
      kind: "meal-published",
      sourceEventId: "meal-post-1",
      meal: "lunch",
      serviceDate: "2026-07-31",
      contentSha: "content-v1",
      preview: "김치찌개 흰밥",
      occurredAtEpochMs: 1_000,
    });

    expect(planned).toHaveLength(2);
    expect(planned.map((item) => item.userId)).toEqual([
      "user-1",
      "user-2",
    ]);
    expect(new Set(planned.map((item) => item.dedupeKey)).size).toBe(
      2,
    );
    expect(planned[0]?.content).toMatchObject({
      title: "오늘 중식이 올라왔어요",
      path: "/app#meals",
    });
  });

  it("deduplicates a laundry availability event across watch and queue rules", () => {
    const planner = new ServerNotificationPlanner(
      rules({
        watches: [watch("watch-1", "user-1", null)],
        queueEntry: queueEntry("queue-1", "user-2"),
      }),
    );

    const planned = planner.plan({
      kind: "laundry-transition",
      sourceEventId: "laundry-event-1",
      machineId: "tower-3",
      appliance: "washer",
      sessionId: null,
      previousState: "BUSY",
      currentState: "AVAILABLE",
      remainingMinutes: 0,
      occurredAtEpochMs: 2_000,
    });

    expect(planned).toHaveLength(2);
    expect(planned.map((item) => item.userId).sort()).toEqual([
      "user-1",
      "user-2",
    ]);
    expect(planned.every((item) => item.kind === "laundry-available")).toBe(
      true,
    );
  });

  it("plans threshold, completion, attendance and device-specific login events", () => {
    const planner = new ServerNotificationPlanner(
      rules({
        watches: [watch("watch-1", "user-1", "session-1")],
      }),
    );
    const finishing = planner.plan({
      kind: "laundry-transition",
      sourceEventId: "tick-1",
      machineId: "tower-3",
      appliance: "washer",
      sessionId: "session-1",
      previousState: "BUSY",
      currentState: "BUSY",
      remainingMinutes: 5,
      occurredAtEpochMs: 3_000,
    });
    expect(finishing).toMatchObject([
      { kind: "laundry-finishing", userId: "user-1" },
    ]);

    expect(
      planner.plan({
        kind: "attendance-action-required",
        sourceEventId: "attendance-1",
        userId: "user-1",
        attendanceDate: "2026-07-31",
        phase: "evening",
        minutesRemaining: 10,
        occurredAtEpochMs: 4_000,
      }),
    ).toMatchObject([
      {
        kind: "attendance-action-required",
        targetDeviceId: null,
      },
    ]);

    expect(
      planner.plan({
        kind: "login-required",
        sourceEventId: "login-1",
        userId: "user-1",
        desktopDeviceId: "desktop-2",
        reason: "expired",
        occurredAtEpochMs: 5_000,
      }),
    ).toMatchObject([
      {
        kind: "login-required",
        targetDeviceId: null,
        metadata: { desktopDeviceId: "desktop-2" },
      },
    ]);
  });

  it("uses session-less watches only for one-shot availability", () => {
    const planner = new ServerNotificationPlanner(
      rules({
        watches: [watch("watch-available", "user-1", null)],
      }),
    );
    expect(
      planner.plan({
        kind: "laundry-transition",
        sourceEventId: "completed-session",
        machineId: "tower-3",
        appliance: "washer",
        sessionId: "session-1",
        previousState: "BUSY",
        currentState: "COMPLETED",
        remainingMinutes: 0,
        occurredAtEpochMs: 3_000,
      }),
    ).toEqual([]);
    expect(
      planner.plan({
        kind: "laundry-transition",
        sourceEventId: "available-session",
        machineId: "tower-3",
        appliance: "washer",
        sessionId: null,
        previousState: "BUSY",
        currentState: "AVAILABLE",
        remainingMinutes: 0,
        occurredAtEpochMs: 3_001,
      }),
    ).toMatchObject([{ kind: "laundry-available" }]);
  });

  it("keeps attendance notifications off unless the user enabled that phase", () => {
    const event = {
      kind: "attendance-action-required",
      sourceEventId: "attendance-1",
      userId: "user-1",
      attendanceDate: "2026-07-31",
      phase: "morning",
      minutesRemaining: 30,
      occurredAtEpochMs: 4_000,
    } as const;
    expect(
      new ServerNotificationPlanner(
        rules({ attendanceEnabled: false }),
      ).plan(event),
    ).toEqual([]);
    expect(
      new ServerNotificationPlanner(
        rules({ attendanceEnabled: true }),
      ).plan(event),
    ).toHaveLength(1);
  });
});

function watch(
  id: string,
  userId: string,
  sessionId: string | null,
): LaundryWatch {
  return {
    id,
    userId,
    machineId: "tower-3",
    appliance: "washer",
    sessionId,
    notifyBeforeMinutes: 10,
    notifyWhenAvailable: true,
    status: "active",
    createdAtEpochMs: 1,
    updatedAtEpochMs: 1,
  };
}

function rules(input: {
  readonly mealUsers?: readonly string[];
  readonly watches?: readonly LaundryWatch[];
  readonly queueEntry?: LaundryQueueEntry;
  readonly attendanceEnabled?: boolean;
}): NotificationRuleReader {
  return {
    listMealSubscriberUserIds: () => [...(input.mealUsers ?? [])],
    isAttendancePhaseEnabled: () =>
      input.attendanceEnabled ?? true,
    listActiveWatches: () => [...(input.watches ?? [])],
    findWaitingQueueHead: () => input.queueEntry ?? null,
  };
}

function queueEntry(
  id: string,
  userId: string,
): LaundryQueueEntry {
  return {
    id,
    userId,
    machineId: "tower-3",
    appliance: "washer",
    status: "waiting",
    joinedAtEpochMs: 1,
    leftAtEpochMs: null,
    position: 1,
  };
}
