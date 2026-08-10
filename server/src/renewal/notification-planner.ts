import {
  ATTENDANCE_SNAPSHOT_FRESH_MS,
  DESKTOP_ONLINE_WINDOW_MS,
  attendanceReminderWindowAt,
  type AttendanceFallbackReason,
  type AttendanceReminderWindow,
} from "./attendance-policy";
import type {
  AttendanceSnapshotRecord,
  NotificationRecord,
  RenewalStore,
} from "../workers/account-storage";

export async function planAttendanceNotifications(store: RenewalStore, nowEpochMs: number): Promise<number> {
  const window = attendanceReminderWindowAt(nowEpochMs);
  if (!window) return 0;
  const userIds = [...new Set(await store.listAttendanceSubscriberUserIds(window.phase))];
  let created = 0;
  for (const userId of userIds) {
    const preference = await store.getAttendancePreference(userId);
    if (!preference
      || preference.skipAttendanceDate === window.attendanceDate
      || (preference.skipSunday && isSunday(window.attendanceDate))) continue;
    const candidate = await notificationForUser(store, userId, window, nowEpochMs);
    if (!candidate || !(await store.insertNotification(candidate))) continue;
    created += 1;
  }
  return created;
}

function isSunday(isoDate: string): boolean {
  return new Date(`${isoDate}T00:00:00.000Z`).getUTCDay() === 0;
}

async function notificationForUser(store: RenewalStore, userId: string, window: AttendanceReminderWindow, now: number): Promise<NotificationRecord | null> {
  const snapshot = await store.getLatestAttendanceSnapshot(userId);
  if (snapshot?.attendanceDate === window.attendanceDate) {
    if ((window.phase === "morning" ? snapshot.morningChecked : snapshot.eveningChecked) || provesInactive(snapshot, window.attendanceDate)) return null;
    if (snapshot.cohortStatus === "active" && isFresh(snapshot, now)) return buildNotification(userId, window, null, now);
    if (["upcoming", "ended", "none"].includes(snapshot.cohortStatus) && isFresh(snapshot, now)) return null;
  }
  const devices = await store.listDesktopDevices(userId);
  const recent = devices.filter((device) => device.lastSeenAtEpochMs !== null && now - device.lastSeenAtEpochMs <= DESKTOP_ONLINE_WINDOW_MS && device.lastSeenAtEpochMs <= now + 5 * 60_000);
  let reason: AttendanceFallbackReason;
  if (recent.length === 0) reason = "desktop-offline";
  else if (recent.every((device) => device.lmsSessionState !== "connected") && recent.some((device) => device.lmsSessionState === "login-required")) reason = "login-required";
  else if (!snapshot || snapshot.attendanceDate !== window.attendanceDate) reason = "snapshot-missing";
  else reason = "snapshot-stale";
  return buildNotification(userId, window, reason, now);
}

function buildNotification(userId: string, window: AttendanceReminderWindow, reason: AttendanceFallbackReason | null, now: number): NotificationRecord {
  const phaseLabel = window.phase === "morning" ? "입실" : "퇴실";
  const title = window.slot === "before-10" ? `${phaseLabel} 체크 마감 10분 전` : `${phaseLabel} 체크가 필요합니다`;
  const body = reason === "desktop-offline"
    ? "PC가 연결되지 않아 출석 상태를 확인할 수 없습니다. LMS에서 직접 확인해 주세요."
    : reason === "login-required"
      ? "PC의 LMS 로그인이 만료되어 출석 상태를 확인할 수 없습니다."
      : reason
        ? "최근 출석 상태를 확인할 수 없습니다. LMS에서 직접 확인해 주세요."
        : `${phaseLabel} 체크 상태가 아직 완료되지 않았습니다.`;
  const id = crypto.randomUUID();
  const payload = {
    notificationId: id,
    kind: "attendance-action-required",
    title,
    body,
    path: "/dashboard.html#attendance",
    createdAtEpochMs: now,
    expiresAtEpochMs: window.endsAtEpochMs,
    attendanceDate: window.attendanceDate,
    phase: window.phase,
    slot: window.slot,
    status: reason ? "unverified" : "unchecked",
    reason,
  };
  return {
    id,
    userId,
    sourceEventId: `attendance:${window.attendanceDate}:${window.phase}:${window.slot}`,
    kind: "attendance-action-required",
    title,
    body,
    path: "/dashboard.html#attendance",
    payloadJson: JSON.stringify(payload),
    createdAtEpochMs: now,
    dueAtEpochMs: window.dueAtEpochMs,
    expiresAtEpochMs: window.endsAtEpochMs,
    desktopAttempt: 0,
  };
}

function isFresh(snapshot: AttendanceSnapshotRecord, now: number): boolean {
  return now - snapshot.collectedAtEpochMs <= ATTENDANCE_SNAPSHOT_FRESH_MS && snapshot.collectedAtEpochMs <= now + 5 * 60_000;
}

function provesInactive(snapshot: AttendanceSnapshotRecord, attendanceDate: string): boolean {
  return (snapshot.cohortStatus === "upcoming" && snapshot.cohortStartDate !== null && attendanceDate < snapshot.cohortStartDate)
    || (snapshot.cohortStatus === "ended" && snapshot.cohortEndDate !== null && attendanceDate > snapshot.cohortEndDate);
}
