export const ATTENDANCE_SNAPSHOT_FRESH_MS = 15 * 60_000;
export const ATTENDANCE_CLIENT_CLOCK_SKEW_MS = 5 * 60_000;
export const DESKTOP_ONLINE_WINDOW_MS = 5 * 60_000;

const KST_OFFSET_MS = 9 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const MORNING_EARLIEST_MINUTE = 4 * 60;
const MORNING_DEADLINE_MINUTE = 10 * 60;
const EVENING_START_MINUTE = 23 * 60;
const DEADLINE_GRACE_MINUTES = 10;
const ALLOWED_INTERVAL_MINUTES = new Set([1, 3, 5, 10, 15, 30]);

export type AttendancePhase = "morning" | "evening";
export type AttendanceSlot = string;
export type AttendanceFallbackReason = "desktop-offline" | "login-required" | "snapshot-missing" | "snapshot-stale";

export interface AttendanceReminderSchedule {
  morningStartHour: number;
  eveningEndHour: number;
  morningIntervalMinutes: number;
  eveningIntervalMinutes: number;
}

export const DEFAULT_ATTENDANCE_REMINDER_SCHEDULE: Readonly<AttendanceReminderSchedule> = Object.freeze({
  morningStartHour: 9,
  eveningEndHour: 4,
  morningIntervalMinutes: 15,
  eveningIntervalMinutes: 15,
});

export interface AttendanceReminderWindow {
  attendanceDate: string;
  phase: AttendancePhase;
  slot: AttendanceSlot;
  isDeadline: boolean;
  dueAtEpochMs: number;
  endsAtEpochMs: number;
}

interface KstClock {
  calendarDay: number;
  minutes: number;
}

/** Returns every phase that could be active for at least one valid account schedule. */
export function attendancePlanningPhasesAt(nowEpochMs: number): AttendancePhase[] {
  const { minutes } = kstClock(nowEpochMs);
  const phases: AttendancePhase[] = [];
  if (minutes >= MORNING_EARLIEST_MINUTE
    && minutes < MORNING_DEADLINE_MINUTE + DEADLINE_GRACE_MINUTES) phases.push("morning");
  if (minutes >= EVENING_START_MINUTE || minutes < 4 * 60 + DEADLINE_GRACE_MINUTES) phases.push("evening");
  return phases;
}

/** Maps the current minute into the account's stable, interval-aligned notification slot. */
export function attendanceReminderWindowAt(
  nowEpochMs: number,
  schedule: AttendanceReminderSchedule = DEFAULT_ATTENDANCE_REMINDER_SCHEDULE,
  requestedPhase?: AttendancePhase,
): AttendanceReminderWindow | null {
  validateSchedule(schedule);
  const clock = kstClock(nowEpochMs);
  const phases = requestedPhase ? [requestedPhase] : attendancePlanningPhasesAt(nowEpochMs);
  for (const phase of phases) {
    const window = phase === "morning"
      ? morningWindow(clock, schedule)
      : eveningWindow(clock, schedule);
    if (window) return window;
  }
  return null;
}

function morningWindow(clock: KstClock, schedule: AttendanceReminderSchedule): AttendanceReminderWindow | null {
  const startMinute = schedule.morningStartHour * 60;
  if (clock.minutes < startMinute
    || clock.minutes >= MORNING_DEADLINE_MINUTE + DEADLINE_GRACE_MINUTES) return null;
  const isDeadline = clock.minutes >= MORNING_DEADLINE_MINUTE;
  const dueMinute = isDeadline
    ? MORNING_DEADLINE_MINUTE
    : startMinute + Math.floor((clock.minutes - startMinute) / schedule.morningIntervalMinutes)
      * schedule.morningIntervalMinutes;
  const endsMinute = isDeadline
    ? MORNING_DEADLINE_MINUTE + DEADLINE_GRACE_MINUTES
    : Math.min(dueMinute + schedule.morningIntervalMinutes, MORNING_DEADLINE_MINUTE);
  return buildWindow(clock.calendarDay, "morning", dueMinute, endsMinute, isDeadline);
}

function eveningWindow(clock: KstClock, schedule: AttendanceReminderSchedule): AttendanceReminderWindow | null {
  const durationMinutes = 60 + schedule.eveningEndHour * 60;
  let attendanceDay = clock.calendarDay;
  let elapsedMinutes: number;
  if (clock.minutes >= EVENING_START_MINUTE) {
    elapsedMinutes = clock.minutes - EVENING_START_MINUTE;
  } else {
    attendanceDay -= DAY_MS;
    elapsedMinutes = 60 + clock.minutes;
  }
  if (elapsedMinutes < 0 || elapsedMinutes >= durationMinutes + DEADLINE_GRACE_MINUTES) return null;
  const isDeadline = elapsedMinutes >= durationMinutes;
  const dueOffset = isDeadline
    ? durationMinutes
    : Math.floor(elapsedMinutes / schedule.eveningIntervalMinutes) * schedule.eveningIntervalMinutes;
  const endsOffset = isDeadline
    ? durationMinutes + DEADLINE_GRACE_MINUTES
    : Math.min(dueOffset + schedule.eveningIntervalMinutes, durationMinutes);
  return buildWindow(
    attendanceDay,
    "evening",
    EVENING_START_MINUTE + dueOffset,
    EVENING_START_MINUTE + endsOffset,
    isDeadline,
  );
}

function buildWindow(
  attendanceDay: number,
  phase: AttendancePhase,
  dueMinute: number,
  endsMinute: number,
  isDeadline: boolean,
): AttendanceReminderWindow {
  const localDueMinute = dueMinute % (24 * 60);
  return {
    attendanceDate: new Date(attendanceDay).toISOString().slice(0, 10),
    phase,
    slot: `${Math.floor(localDueMinute / 60).toString().padStart(2, "0")}${(localDueMinute % 60).toString().padStart(2, "0")}`,
    isDeadline,
    dueAtEpochMs: attendanceDay - KST_OFFSET_MS + dueMinute * 60_000,
    endsAtEpochMs: attendanceDay - KST_OFFSET_MS + endsMinute * 60_000,
  };
}

function kstClock(nowEpochMs: number): KstClock {
  if (!Number.isSafeInteger(nowEpochMs) || nowEpochMs < 0) throw new TypeError("Invalid reminder time");
  const kstNow = new Date(nowEpochMs + KST_OFFSET_MS);
  return {
    minutes: kstNow.getUTCHours() * 60 + kstNow.getUTCMinutes(),
    calendarDay: Date.UTC(kstNow.getUTCFullYear(), kstNow.getUTCMonth(), kstNow.getUTCDate()),
  };
}

function validateSchedule(schedule: AttendanceReminderSchedule): void {
  if (!Number.isInteger(schedule.morningStartHour) || schedule.morningStartHour < 4 || schedule.morningStartHour > 9
    || !Number.isInteger(schedule.eveningEndHour) || schedule.eveningEndHour < 0 || schedule.eveningEndHour > 4
    || !ALLOWED_INTERVAL_MINUTES.has(schedule.morningIntervalMinutes)
    || !ALLOWED_INTERVAL_MINUTES.has(schedule.eveningIntervalMinutes)) {
    throw new TypeError("Invalid attendance reminder schedule");
  }
}
