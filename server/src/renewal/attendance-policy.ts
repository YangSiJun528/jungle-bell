export const ATTENDANCE_SNAPSHOT_FRESH_MS = 15 * 60_000;
export const ATTENDANCE_CLIENT_CLOCK_SKEW_MS = 5 * 60_000;
export const DESKTOP_ONLINE_WINDOW_MS = 5 * 60_000;

const KST_OFFSET_MS = 9 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

export type AttendancePhase = "morning" | "evening";
export type AttendanceSlot = "before-10" | "deadline";
export type AttendanceFallbackReason = "desktop-offline" | "login-required" | "snapshot-missing" | "snapshot-stale";

export interface AttendanceReminderWindow {
  attendanceDate: string;
  phase: AttendancePhase;
  slot: AttendanceSlot;
  dueAtEpochMs: number;
  endsAtEpochMs: number;
}

export function attendanceReminderWindowAt(nowEpochMs: number): AttendanceReminderWindow | null {
  if (!Number.isSafeInteger(nowEpochMs) || nowEpochMs < 0) throw new TypeError("Invalid reminder time");
  const kstNow = new Date(nowEpochMs + KST_OFFSET_MS);
  const minutes = kstNow.getUTCHours() * 60 + kstNow.getUTCMinutes();
  const calendarDay = Date.UTC(kstNow.getUTCFullYear(), kstNow.getUTCMonth(), kstNow.getUTCDate());
  let phase: AttendancePhase;
  let slot: AttendanceSlot;
  let attendanceDay = calendarDay;
  let dueMinute: number;
  if (minutes >= 9 * 60 + 50 && minutes < 10 * 60) {
    phase = "morning"; slot = "before-10"; dueMinute = 9 * 60 + 50;
  } else if (minutes >= 10 * 60 && minutes < 10 * 60 + 10) {
    phase = "morning"; slot = "deadline"; dueMinute = 10 * 60;
  } else if (minutes >= 3 * 60 + 50 && minutes < 4 * 60) {
    phase = "evening"; slot = "before-10"; dueMinute = 3 * 60 + 50; attendanceDay -= DAY_MS;
  } else if (minutes >= 4 * 60 && minutes < 4 * 60 + 10) {
    phase = "evening"; slot = "deadline"; dueMinute = 4 * 60; attendanceDay -= DAY_MS;
  } else {
    return null;
  }
  const dueAtEpochMs = calendarDay - KST_OFFSET_MS + dueMinute * 60_000;
  return {
    attendanceDate: new Date(attendanceDay).toISOString().slice(0, 10),
    phase,
    slot,
    dueAtEpochMs,
    endsAtEpochMs: dueAtEpochMs + 10 * 60_000,
  };
}
