import { describe, expect, it } from "vitest";

import { attendanceNotificationEvent } from "../app.js";
import type { AttendanceSnapshotRecord } from "../infra/sqlite/index.js";

describe("attendance notification policy", () => {
  it("emits only T-10 and deadline morning notifications per attendance date", () => {
    const eventIds = [
      "2026-07-31T09:00:00+09:00",
      "2026-07-31T09:49:59+09:00",
      "2026-07-31T09:50:00+09:00",
      "2026-07-31T09:59:59+09:00",
      "2026-07-31T10:00:00+09:00",
      "2026-07-31T10:09:59+09:00",
    ]
      .map((time) => {
        const now = Date.parse(time);
        return attendanceNotificationEvent(
          snapshot({
            attendanceDate: "2026-07-31",
            collectedAtEpochMs: now,
            morningChecked: false,
          }),
          now,
        )?.sourceEventId;
      })
      .filter((value): value is string => value !== undefined);

    expect(new Set(eventIds)).toEqual(
      new Set([
        "attendance:2026-07-31:morning:before-10",
        "attendance:2026-07-31:morning:deadline",
      ]),
    );
  });

  it("does not notify outside the bounded morning window", () => {
    for (const time of [
      "2026-07-31T08:59:59+09:00",
      "2026-07-31T10:10:00+09:00",
      "2026-07-31T23:00:00+09:00",
    ]) {
      const now = Date.parse(time);
      expect(
        attendanceNotificationEvent(
          snapshot({
            attendanceDate: "2026-07-31",
            collectedAtEpochMs: now,
            morningChecked: false,
          }),
          now,
        ),
      ).toBeNull();
    }
  });

  it("keeps the previous attendance date through the evening deadline slot", () => {
    const cases = [
      ["2026-08-01T03:50:00+09:00", "before-10", 10],
      ["2026-08-01T03:59:59+09:00", "before-10", 10],
      ["2026-08-01T04:00:00+09:00", "deadline", 0],
      ["2026-08-01T04:09:59+09:00", "deadline", 0],
    ] as const;

    const ids = new Set<string>();
    for (const [time, slot, minutesRemaining] of cases) {
      const now = Date.parse(time);
      const event = attendanceNotificationEvent(
        snapshot({
          attendanceDate: "2026-07-31",
          collectedAtEpochMs: now,
          morningChecked: true,
          eveningChecked: false,
        }),
        now,
      );
      expect(event).toMatchObject({
        sourceEventId: `attendance:2026-07-31:evening:${slot}`,
        attendanceDate: "2026-07-31",
        phase: "evening",
        minutesRemaining,
        slot,
        status: "unchecked",
        reason: null,
        occurredAtEpochMs: Date.parse(
          slot === "before-10"
            ? "2026-08-01T03:50:00+09:00"
            : "2026-08-01T04:00:00+09:00",
        ),
      });
      if (event !== null) ids.add(event.sourceEventId);
    }
    expect(ids.size).toBe(2);
  });

  it("rejects stale, mismatched, inactive, and already checked snapshots", () => {
    const now = Date.parse("2026-07-31T09:45:00+09:00");
    const invalid = [
      snapshot({
        attendanceDate: "2026-07-30",
        collectedAtEpochMs: now,
        morningChecked: false,
      }),
      snapshot({
        attendanceDate: "2026-07-31",
        collectedAtEpochMs: now - 15 * 60 * 1_000 - 1,
        morningChecked: false,
      }),
      snapshot({
        attendanceDate: "2026-07-31",
        collectedAtEpochMs: now,
        morningChecked: false,
        cohortStatus: "ended",
      }),
      snapshot({
        attendanceDate: "2026-07-31",
        collectedAtEpochMs: now,
        morningChecked: true,
      }),
    ];
    for (const value of invalid) {
      expect(attendanceNotificationEvent(value, now)).toBeNull();
    }
  });
});

function snapshot(
  overrides: Partial<AttendanceSnapshotRecord>,
): AttendanceSnapshotRecord {
  const collectedAtEpochMs =
    overrides.collectedAtEpochMs ??
    Date.parse("2026-07-31T09:00:00+09:00");
  const receivedAtEpochMs =
    overrides.receivedAtEpochMs ?? collectedAtEpochMs;
  return {
    userId: "user-1",
    sourceDeviceId: "desktop-1",
    attendanceDate: "2026-07-31",
    cohortId: "cohort-1",
    cohortStatus: "active",
    cohortStartDate: "2026-07-01",
    cohortEndDate: "2026-08-31",
    morningChecked: false,
    eveningChecked: false,
    collectedAtEpochMs,
    receivedAtEpochMs,
    version: 1,
    ...overrides,
  };
}
