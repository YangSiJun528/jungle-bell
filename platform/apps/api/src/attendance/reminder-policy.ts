import type { AttendanceSnapshotRecord } from "../infra/sqlite/index.js";
import type {
  AttendanceReminderFallbackReason,
  AttendanceReminderSlot,
  NotificationSourceEvent,
} from "../notifications/contracts.js";

export const ATTENDANCE_SNAPSHOT_FRESH_MS = 15 * 60 * 1_000;
export const ATTENDANCE_CLIENT_CLOCK_SKEW_MS = 5 * 60 * 1_000;

const KST_OFFSET_MS = 9 * 60 * 60 * 1_000;
const DAY_MS = 24 * 60 * 60 * 1_000;
const REMINDER_WINDOW_MS = 10 * 60 * 1_000;

export type AttendanceNotificationEvent = Extract<
  NotificationSourceEvent,
  { readonly kind: "attendance-action-required" }
>;

export interface AttendanceReminderWindow {
  readonly attendanceDate: string;
  readonly phase: "morning" | "evening";
  readonly slot: AttendanceReminderSlot;
  readonly minutesRemaining: 10 | 0;
  readonly dueAtEpochMs: number;
  readonly endsAtEpochMs: number;
}

export function attendanceReminderWindowAt(
  nowEpochMs: number,
): AttendanceReminderWindow | null {
  assertEpoch(nowEpochMs);
  const kstNow = new Date(nowEpochMs + KST_OFFSET_MS);
  const localMinutes =
    kstNow.getUTCHours() * 60 + kstNow.getUTCMinutes();
  const calendarDay = Date.UTC(
    kstNow.getUTCFullYear(),
    kstNow.getUTCMonth(),
    kstNow.getUTCDate(),
  );

  let phase: "morning" | "evening";
  let attendanceDay: number;
  let slot: AttendanceReminderSlot;
  let dueMinute: number;
  if (localMinutes >= 9 * 60 + 50 && localMinutes < 10 * 60) {
    phase = "morning";
    attendanceDay = calendarDay;
    slot = "before-10";
    dueMinute = 9 * 60 + 50;
  } else if (
    localMinutes >= 10 * 60 &&
    localMinutes < 10 * 60 + 10
  ) {
    phase = "morning";
    attendanceDay = calendarDay;
    slot = "deadline";
    dueMinute = 10 * 60;
  } else if (
    localMinutes >= 3 * 60 + 50 &&
    localMinutes < 4 * 60
  ) {
    phase = "evening";
    attendanceDay = calendarDay - DAY_MS;
    slot = "before-10";
    dueMinute = 3 * 60 + 50;
  } else if (
    localMinutes >= 4 * 60 &&
    localMinutes < 4 * 60 + 10
  ) {
    phase = "evening";
    attendanceDay = calendarDay - DAY_MS;
    slot = "deadline";
    dueMinute = 4 * 60;
  } else {
    return null;
  }

  const dueAtEpochMs =
    calendarDay - KST_OFFSET_MS + dueMinute * 60 * 1_000;
  return {
    attendanceDate: new Date(attendanceDay)
      .toISOString()
      .slice(0, 10),
    phase,
    slot,
    minutesRemaining: slot === "before-10" ? 10 : 0,
    dueAtEpochMs,
    endsAtEpochMs: dueAtEpochMs + REMINDER_WINDOW_MS,
  };
}

export function attendanceNotificationEvent(
  snapshot: AttendanceSnapshotRecord,
  nowEpochMs: number,
): AttendanceNotificationEvent | null {
  const window = attendanceReminderWindowAt(nowEpochMs);
  if (
    window === null ||
    snapshot.attendanceDate !== window.attendanceDate ||
    snapshot.cohortStatus !== "active" ||
    !isFreshAttendanceSnapshot(snapshot, nowEpochMs) ||
    isPhaseChecked(snapshot, window.phase)
  ) {
    return null;
  }
  return createAttendanceNotificationEvent({
    userId: snapshot.userId,
    window,
    status: "unchecked",
    reason: null,
  });
}

export function createAttendanceNotificationEvent(input: {
  readonly userId: string;
  readonly window: AttendanceReminderWindow;
  readonly status: "unchecked" | "unverified";
  readonly reason: AttendanceReminderFallbackReason | null;
}): AttendanceNotificationEvent {
  return {
    kind: "attendance-action-required",
    sourceEventId: `attendance:${input.window.attendanceDate}:${input.window.phase}:${input.window.slot}`,
    userId: input.userId,
    attendanceDate: input.window.attendanceDate,
    phase: input.window.phase,
    slot: input.window.slot,
    minutesRemaining: input.window.minutesRemaining,
    status: input.status,
    reason: input.reason,
    occurredAtEpochMs: input.window.dueAtEpochMs,
  };
}

export function isFreshAttendanceSnapshot(
  snapshot: AttendanceSnapshotRecord,
  nowEpochMs: number,
): boolean {
  return (
    nowEpochMs - snapshot.collectedAtEpochMs <=
      ATTENDANCE_SNAPSHOT_FRESH_MS &&
    snapshot.collectedAtEpochMs <=
      nowEpochMs + ATTENDANCE_CLIENT_CLOCK_SKEW_MS
  );
}

export function isPhaseChecked(
  snapshot: AttendanceSnapshotRecord,
  phase: "morning" | "evening",
): boolean {
  return phase === "morning"
    ? snapshot.morningChecked
    : snapshot.eveningChecked;
}

function assertEpoch(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("Attendance reminder time is invalid.");
  }
}
