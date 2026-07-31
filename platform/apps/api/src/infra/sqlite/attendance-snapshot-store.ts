import {
  expectRow,
  readBoolean,
  readInteger,
  readNullableText,
  readText,
  SqliteDataIntegrityError,
} from "./codec.js";
import type { SqliteDatabase } from "./database.js";

export const ATTENDANCE_COHORT_STATUSES = [
  "active",
  "upcoming",
  "ended",
  "none",
  "unknown",
] as const;

export type AttendanceCohortStatus =
  (typeof ATTENDANCE_COHORT_STATUSES)[number];

export interface AttendanceSnapshotInput {
  readonly userId: string;
  readonly sourceDeviceId: string;
  readonly attendanceDate: string;
  readonly cohortId: string | null;
  readonly cohortStatus: AttendanceCohortStatus;
  readonly cohortStartDate: string | null;
  readonly cohortEndDate: string | null;
  readonly morningChecked: boolean;
  readonly eveningChecked: boolean;
  readonly collectedAtEpochMs: number;
  readonly receivedAtEpochMs: number;
}

export interface AttendanceSnapshotRecord extends AttendanceSnapshotInput {
  readonly version: number;
}

export interface AttendanceSnapshotWriteResult {
  readonly accepted: boolean;
  readonly snapshot: AttendanceSnapshotRecord;
}

export interface AttendanceSnapshotStore {
  putNewest(
    snapshot: AttendanceSnapshotInput,
  ): Promise<AttendanceSnapshotWriteResult>;
  getLatest(userId: string): Promise<AttendanceSnapshotRecord | null>;
}

const COLUMNS = `
  user_id,
  source_device_id,
  attendance_date,
  cohort_id,
  cohort_status,
  cohort_start_date,
  cohort_end_date,
  morning_checked,
  evening_checked,
  collected_at_epoch_ms,
  received_at_epoch_ms,
  version
`;

const KEYS = [
  "user_id",
  "source_device_id",
  "attendance_date",
  "cohort_id",
  "cohort_status",
  "cohort_start_date",
  "cohort_end_date",
  "morning_checked",
  "evening_checked",
  "collected_at_epoch_ms",
  "received_at_epoch_ms",
  "version",
] as const;

export class SqliteAttendanceSnapshotStore
  implements AttendanceSnapshotStore
{
  constructor(private readonly database: SqliteDatabase) {}

  async putNewest(
    snapshot: AttendanceSnapshotInput,
  ): Promise<AttendanceSnapshotWriteResult> {
    validateSnapshot(snapshot);
    const write = this.database.transaction(() => {
      const current = this.read(snapshot.userId);
      if (
        current !== null &&
        snapshot.collectedAtEpochMs <= current.collectedAtEpochMs
      ) {
        return { accepted: false, snapshot: current };
      }

      this.database
        .prepare(`
          INSERT INTO attendance_snapshots (
            ${COLUMNS}
          ) VALUES (
            @userId,
            @sourceDeviceId,
            @attendanceDate,
            @cohortId,
            @cohortStatus,
            @cohortStartDate,
            @cohortEndDate,
            @morningChecked,
            @eveningChecked,
            @collectedAtEpochMs,
            @receivedAtEpochMs,
            0
          )
          ON CONFLICT (user_id) DO UPDATE SET
            source_device_id = excluded.source_device_id,
            attendance_date = excluded.attendance_date,
            cohort_id = excluded.cohort_id,
            cohort_status = excluded.cohort_status,
            cohort_start_date = excluded.cohort_start_date,
            cohort_end_date = excluded.cohort_end_date,
            morning_checked = excluded.morning_checked,
            evening_checked = excluded.evening_checked,
            collected_at_epoch_ms = excluded.collected_at_epoch_ms,
            received_at_epoch_ms = excluded.received_at_epoch_ms,
            version = attendance_snapshots.version + 1
        `)
        .run({
          ...snapshot,
          morningChecked: Number(snapshot.morningChecked),
          eveningChecked: Number(snapshot.eveningChecked),
        });

      const stored = this.read(snapshot.userId);
      if (stored === null) {
        throw new SqliteDataIntegrityError(
          "Attendance snapshot write did not persist a row.",
        );
      }
      return { accepted: true, snapshot: stored };
    });
    return write.immediate();
  }

  async getLatest(
    userId: string,
  ): Promise<AttendanceSnapshotRecord | null> {
    assertIdentifier(userId, "user ID");
    return this.read(userId);
  }

  private read(userId: string): AttendanceSnapshotRecord | null {
    const row = this.database
      .prepare(
        `SELECT ${COLUMNS} FROM attendance_snapshots WHERE user_id = ?`,
      )
      .get(userId);
    return row === undefined ? null : mapSnapshot(row);
  }
}

export class InMemoryAttendanceSnapshotStore
  implements AttendanceSnapshotStore
{
  private readonly snapshots = new Map<string, AttendanceSnapshotRecord>();

  async putNewest(
    snapshot: AttendanceSnapshotInput,
  ): Promise<AttendanceSnapshotWriteResult> {
    validateSnapshot(snapshot);
    const current = this.snapshots.get(snapshot.userId);
    if (
      current !== undefined &&
      snapshot.collectedAtEpochMs <= current.collectedAtEpochMs
    ) {
      return { accepted: false, snapshot: { ...current } };
    }
    const stored: AttendanceSnapshotRecord = {
      ...snapshot,
      version: current === undefined ? 0 : current.version + 1,
    };
    this.snapshots.set(snapshot.userId, stored);
    return { accepted: true, snapshot: { ...stored } };
  }

  async getLatest(
    userId: string,
  ): Promise<AttendanceSnapshotRecord | null> {
    const snapshot = this.snapshots.get(userId);
    return snapshot === undefined ? null : { ...snapshot };
  }
}

function mapSnapshot(value: unknown): AttendanceSnapshotRecord {
  const row = expectRow(value, KEYS, "attendance snapshot");
  const cohortStatus = readText(row, "cohort_status");
  if (
    !(ATTENDANCE_COHORT_STATUSES as readonly string[]).includes(
      cohortStatus,
    )
  ) {
    throw new SqliteDataIntegrityError(
      "Attendance cohort status is invalid.",
    );
  }
  return {
    userId: readText(row, "user_id"),
    sourceDeviceId: readText(row, "source_device_id"),
    attendanceDate: readText(row, "attendance_date"),
    cohortId: readNullableText(row, "cohort_id"),
    cohortStatus: cohortStatus as AttendanceCohortStatus,
    cohortStartDate: readNullableText(row, "cohort_start_date"),
    cohortEndDate: readNullableText(row, "cohort_end_date"),
    morningChecked: readBoolean(row, "morning_checked"),
    eveningChecked: readBoolean(row, "evening_checked"),
    collectedAtEpochMs: readInteger(row, "collected_at_epoch_ms"),
    receivedAtEpochMs: readInteger(row, "received_at_epoch_ms"),
    version: readInteger(row, "version"),
  };
}

function validateSnapshot(snapshot: AttendanceSnapshotInput): void {
  assertIdentifier(snapshot.userId, "user ID");
  assertIdentifier(snapshot.sourceDeviceId, "source device ID");
  assertDate(snapshot.attendanceDate, false, "attendance date");
  assertOptionalIdentifier(snapshot.cohortId, "cohort ID");
  if (
    !(ATTENDANCE_COHORT_STATUSES as readonly string[]).includes(
      snapshot.cohortStatus,
    )
  ) {
    throw new SqliteDataIntegrityError(
      "Attendance cohort status is invalid.",
    );
  }
  assertDate(snapshot.cohortStartDate, true, "cohort start date");
  assertDate(snapshot.cohortEndDate, true, "cohort end date");
  if (
    snapshot.cohortStartDate !== null &&
    snapshot.cohortEndDate !== null &&
    snapshot.cohortStartDate > snapshot.cohortEndDate
  ) {
    throw new SqliteDataIntegrityError(
      "Attendance cohort date range is invalid.",
    );
  }
  assertEpoch(snapshot.collectedAtEpochMs, "collection time");
  assertEpoch(snapshot.receivedAtEpochMs, "receipt time");
}

function assertIdentifier(value: string, label: string): void {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 128 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new SqliteDataIntegrityError(`${label} is invalid.`);
  }
}

function assertOptionalIdentifier(
  value: string | null,
  label: string,
): void {
  if (value !== null) {
    assertIdentifier(value, label);
  }
}

function assertDate(
  value: string | null,
  nullable: boolean,
  label: string,
): void {
  if (value === null && nullable) {
    return;
  }
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(value) ||
    Number.isNaN(Date.parse(`${value}T00:00:00.000Z`))
  ) {
    throw new SqliteDataIntegrityError(`${label} is invalid.`);
  }
}

function assertEpoch(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new SqliteDataIntegrityError(`${label} is invalid.`);
  }
}
