import { ATTENDANCE_CLIENT_CLOCK_SKEW_MS, ATTENDANCE_SNAPSHOT_FRESH_MS } from "../renewal/attendance-policy";
import type { AttendanceSnapshotRecord } from "../workers/account-storage";

export interface AttendanceEnvelope {
  attendance: Record<string, unknown> | null;
  freshness: "fresh" | "stale" | "missing";
}

export function attendanceEnvelope(snapshot: AttendanceSnapshotRecord | null, nowEpochMs: number): AttendanceEnvelope {
  if (!snapshot) return { attendance: null, freshness: "missing" };
  const freshness = snapshot.collectedAtEpochMs <= nowEpochMs + ATTENDANCE_CLIENT_CLOCK_SKEW_MS
    && nowEpochMs - snapshot.collectedAtEpochMs <= ATTENDANCE_SNAPSHOT_FRESH_MS ? "fresh" : "stale";
  return {
    attendance: {
      attendanceDate: snapshot.attendanceDate, cohortId: snapshot.cohortId,
      cohortStatus: snapshot.cohortStatus, cohortStartDate: snapshot.cohortStartDate,
      cohortEndDate: snapshot.cohortEndDate, morningChecked: snapshot.morningChecked,
      eveningChecked: snapshot.eveningChecked, collectedAt: new Date(snapshot.collectedAtEpochMs).toISOString(),
    },
    freshness,
  };
}
