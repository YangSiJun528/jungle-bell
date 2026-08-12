import { ATTENDANCE_CLIENT_CLOCK_SKEW_MS, DESKTOP_ONLINE_WINDOW_MS } from "@jungle-bell/backend-common/renewal/attendance-policy";
import { RenewalError, type Principal } from "../domain/session";
import { attendanceEnvelope, type AttendanceEnvelope } from "../domain/attendance-snapshot";
import type { RenewalStore } from "@jungle-bell/backend-common/ports/account-storage";

export type AttendanceStore = Pick<RenewalStore,
  | "getLatestAttendanceSnapshot"
  | "listDesktopDevices"
  | "putNewestAttendanceSnapshot"
  | "recordDesktopHeartbeat"
>;

export interface AttendanceSnapshotInput {
  attendanceDate: string;
  cohortId: string | null;
  cohortStatus: "active" | "upcoming" | "ended" | "none" | "unknown";
  cohortStartDate: string | null;
  cohortEndDate: string | null;
  morningChecked: boolean;
  eveningChecked: boolean;
  collectedAt: string;
}

export async function readAttendance(store: AttendanceStore, userId: string, nowEpochMs: number): Promise<AttendanceEnvelope> {
  return attendanceEnvelope(await store.getLatestAttendanceSnapshot(userId), nowEpochMs);
}

export async function readMobileAttendance(store: AttendanceStore, userId: string, nowEpochMs: number) {
  const [attendance, devices] = await Promise.all([
    readAttendance(store, userId, nowEpochMs),
    store.listDesktopDevices(userId),
  ]);
  return {
    ...attendance,
    devices: devices
      .sort((left, right) => left.installationId.localeCompare(right.installationId))
      .map((device) => ({
        id: device.installationId,
        deviceLabel: "PC 앱",
        lastSeenAt: device.lastSeenAtEpochMs === null ? null : new Date(device.lastSeenAtEpochMs).toISOString(),
        lmsSessionState: device.lmsSessionState,
        health: device.lastSeenAtEpochMs !== null
          && device.lastSeenAtEpochMs <= nowEpochMs + ATTENDANCE_CLIENT_CLOCK_SKEW_MS
          && nowEpochMs - device.lastSeenAtEpochMs <= DESKTOP_ONLINE_WINDOW_MS ? "online" : "offline",
        appVersion: device.appVersion,
      })),
  };
}

export async function publishAttendance(input: {
  store: AttendanceStore;
  principal: Principal;
  snapshot: AttendanceSnapshotInput;
  nowEpochMs: number;
}): Promise<AttendanceEnvelope> {
  if (input.principal.kind !== "desktop") throw new RenewalError("DESKTOP_SESSION_REQUIRED", 403);
  const collectedAtEpochMs = Date.parse(input.snapshot.collectedAt);
  if (!Number.isSafeInteger(collectedAtEpochMs)
    || collectedAtEpochMs > input.nowEpochMs + ATTENDANCE_CLIENT_CLOCK_SKEW_MS) {
    throw new RenewalError("ATTENDANCE_COLLECTION_TIME_INVALID", 400);
  }
  if (!(await input.store.recordDesktopHeartbeat({
    userId: input.principal.userId, installationId: input.principal.installationId,
    lmsSessionState: "connected", appVersion: null, nowEpochMs: input.nowEpochMs,
  }))) throw new RenewalError("DESKTOP_NOT_REGISTERED", 409);
  const result = await input.store.putNewestAttendanceSnapshot({
    userId: input.principal.userId, sourceInstallationId: input.principal.installationId,
    ...input.snapshot, collectedAtEpochMs, receivedAtEpochMs: input.nowEpochMs,
  });
  return attendanceEnvelope(result.snapshot, input.nowEpochMs);
}

/** Application service boundary used by the HTTP controller. */
export class AttendanceService {
  constructor(private readonly store: AttendanceStore) {}

  readDesktop(userId: string, nowEpochMs: number): Promise<AttendanceEnvelope> {
    return readAttendance(this.store, userId, nowEpochMs);
  }

  readMobile(userId: string, nowEpochMs: number) {
    return readMobileAttendance(this.store, userId, nowEpochMs);
  }

  publish(principal: Principal, snapshot: AttendanceSnapshotInput, nowEpochMs: number): Promise<AttendanceEnvelope> {
    return publishAttendance({ store: this.store, principal, snapshot, nowEpochMs });
  }
}
