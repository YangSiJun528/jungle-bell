import type {
  AttendancePreferenceRecord, AttendanceSnapshotRecord, DesktopRecord, LmsSessionState,
} from "../ports/account-storage";
import type { SqlDatabase } from "../ports/sql-database";

interface SnapshotRow {
  user_id: string; source_installation_id: string; attendance_date: string; cohort_id: string | null;
  cohort_status: AttendanceSnapshotRecord["cohortStatus"]; cohort_start_date: string | null; cohort_end_date: string | null;
  morning_checked: number; evening_checked: number; collected_at_epoch_ms: number; received_at_epoch_ms: number;
}

interface DesktopRow {
  installation_id: string; user_id: string; last_seen_at_epoch_ms: number | null;
  lms_session_state: LmsSessionState; app_version: string | null;
}

export class D1AttendanceRepository {
  constructor(private readonly db: SqlDatabase) {}

  async putNewestSnapshot(value: AttendanceSnapshotRecord): Promise<{ accepted: boolean; snapshot: AttendanceSnapshotRecord }> {
    const result = await this.db.prepare(`INSERT INTO attendance_snapshot (user_id, source_installation_id, attendance_date,
      cohort_id, cohort_status, cohort_start_date, cohort_end_date, morning_checked, evening_checked,
      collected_at_epoch_ms, received_at_epoch_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET source_installation_id = excluded.source_installation_id,
      attendance_date = excluded.attendance_date, cohort_id = excluded.cohort_id, cohort_status = excluded.cohort_status,
      cohort_start_date = excluded.cohort_start_date, cohort_end_date = excluded.cohort_end_date,
      morning_checked = excluded.morning_checked, evening_checked = excluded.evening_checked,
      collected_at_epoch_ms = excluded.collected_at_epoch_ms, received_at_epoch_ms = excluded.received_at_epoch_ms
      WHERE excluded.collected_at_epoch_ms > attendance_snapshot.collected_at_epoch_ms`)
      .bind(value.userId, value.sourceInstallationId, value.attendanceDate, value.cohortId, value.cohortStatus,
        value.cohortStartDate, value.cohortEndDate, value.morningChecked ? 1 : 0, value.eveningChecked ? 1 : 0,
        value.collectedAtEpochMs, value.receivedAtEpochMs).run();
    return { accepted: result.meta.changes === 1, snapshot: (await this.getLatestSnapshot(value.userId))! };
  }

  async getLatestSnapshot(userId: string): Promise<AttendanceSnapshotRecord | null> {
    const row = await this.db.prepare("SELECT * FROM attendance_snapshot WHERE user_id = ?")
      .bind(userId).first<SnapshotRow>();
    return row ? snapshot(row) : null;
  }

  async listSubscriberUserIds(phase: "morning" | "evening"): Promise<string[]> {
    const column = phase === "morning" ? "morning_enabled" : "evening_enabled";
    const result = await this.db.prepare(`SELECT user_id FROM attendance_preference WHERE ${column} = 1`)
      .all<{ user_id: string }>();
    return result.results.map((row) => row.user_id);
  }

  async getPreference(userId: string): Promise<AttendancePreferenceRecord | null> {
    const row = await this.db.prepare(`SELECT morning_enabled, evening_enabled, skip_sunday, skip_attendance_date
      FROM attendance_preference WHERE user_id = ?`).bind(userId).first<{
        morning_enabled: number; evening_enabled: number; skip_sunday: number; skip_attendance_date: string | null;
      }>();
    return row ? {
      morning: row.morning_enabled === 1, evening: row.evening_enabled === 1,
      skipSunday: row.skip_sunday === 1, skipAttendanceDate: row.skip_attendance_date,
    } : null;
  }

  async setPreference(userId: string, preference: AttendancePreferenceRecord, now: number): Promise<void> {
    await this.db.prepare(`INSERT INTO attendance_preference
      (user_id, morning_enabled, evening_enabled, skip_sunday, skip_attendance_date, updated_at_epoch_ms)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET morning_enabled = excluded.morning_enabled,
      evening_enabled = excluded.evening_enabled, skip_sunday = excluded.skip_sunday,
      skip_attendance_date = excluded.skip_attendance_date, updated_at_epoch_ms = excluded.updated_at_epoch_ms`)
      .bind(userId, preference.morning ? 1 : 0, preference.evening ? 1 : 0,
        preference.skipSunday ? 1 : 0, preference.skipAttendanceDate, now).run();
  }

  async listDesktopDevices(userId: string): Promise<DesktopRecord[]> {
    const result = await this.db.prepare(`SELECT installation_id, user_id, last_seen_at_epoch_ms,
      lms_session_state, app_version FROM desktop_device WHERE user_id = ?`).bind(userId).all<DesktopRow>();
    return result.results.map((row) => ({
      installationId: row.installation_id, userId: row.user_id, lastSeenAtEpochMs: row.last_seen_at_epoch_ms,
      lmsSessionState: row.lms_session_state, appVersion: row.app_version,
    }));
  }
}

function snapshot(row: SnapshotRow): AttendanceSnapshotRecord {
  return {
    userId: row.user_id, sourceInstallationId: row.source_installation_id, attendanceDate: row.attendance_date,
    cohortId: row.cohort_id, cohortStatus: row.cohort_status, cohortStartDate: row.cohort_start_date,
    cohortEndDate: row.cohort_end_date, morningChecked: row.morning_checked === 1,
    eveningChecked: row.evening_checked === 1, collectedAtEpochMs: row.collected_at_epoch_ms,
    receivedAtEpochMs: row.received_at_epoch_ms,
  };
}
