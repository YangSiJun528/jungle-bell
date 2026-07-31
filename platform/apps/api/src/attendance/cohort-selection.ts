export interface AttendanceCohort {
  readonly id: string;
  readonly isActive: boolean;
  readonly startDate: string;
  readonly endDate: string | null;
}

export type AttendanceCohortStatus =
  | "active"
  | "upcoming"
  | "ended"
  | "none"
  | "unknown";

export interface AttendanceCohortSelection {
  readonly cohortId: string | null;
  readonly cohortStatus: AttendanceCohortStatus;
  readonly cohortStartDate: string | null;
  readonly cohortEndDate: string | null;
}

interface NormalizedCohort {
  readonly id: string;
  readonly isActive: boolean;
  readonly startDate: string;
  readonly endDate: string | null;
}

export function selectAttendanceCohort(
  cohorts: readonly AttendanceCohort[],
  today: string,
): AttendanceCohortSelection {
  if (!isDateString(today)) {
    throw new Error("ATTENDANCE_DATE_INVALID");
  }
  const normalized = cohorts.flatMap((cohort) => {
    const startDate = normalizeLmsDate(cohort.startDate);
    if (startDate === null) {
      return [];
    }
    return [
      {
        id: cohort.id,
        isActive: cohort.isActive,
        startDate,
        endDate:
          cohort.endDate === null
            ? null
            : normalizeLmsDate(cohort.endDate),
      } satisfies NormalizedCohort,
    ];
  });

  const active = normalized
    .filter(
      (cohort) =>
        cohort.startDate <= today &&
        (cohort.endDate === null || today <= cohort.endDate),
    )
    .sort(compareActive)[0];
  if (active) {
    return selection(active, "active");
  }

  const upcoming = normalized
    .filter((cohort) => cohort.startDate > today)
    .sort(compareUpcoming)[0];
  if (upcoming) {
    return selection(upcoming, "upcoming");
  }

  const ended = normalized
    .filter(
      (cohort): cohort is NormalizedCohort & { endDate: string } =>
        cohort.endDate !== null && cohort.endDate < today,
    )
    .sort((left, right) =>
      right.endDate.localeCompare(left.endDate) ||
      right.startDate.localeCompare(left.startDate) ||
      left.id.localeCompare(right.id),
    )[0];
  if (ended) {
    return selection(ended, "ended");
  }

  return {
    cohortId: null,
    cohortStatus: normalized.length === 0 ? "none" : "unknown",
    cohortStartDate: null,
    cohortEndDate: null,
  };
}

export function kstDateString(epochMs: number): string {
  if (!Number.isSafeInteger(epochMs) || epochMs < 0) {
    throw new Error("ATTENDANCE_TIME_INVALID");
  }
  return new Date(epochMs + 9 * 60 * 60 * 1_000)
    .toISOString()
    .slice(0, 10);
}

function normalizeLmsDate(value: string): string | null {
  if (isDateString(value)) {
    return value;
  }
  const prefix = /^(\d{4}-\d{2}-\d{2})/u.exec(value)?.[1];
  const hasExplicitTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/u.test(value);
  if (prefix && !hasExplicitTimezone && isDateString(prefix)) {
    return prefix;
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return null;
  }
  return kstDateString(timestamp);
}

function isDateString(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    return false;
  }
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return (
    Number.isFinite(timestamp) &&
    new Date(timestamp).toISOString().slice(0, 10) === value
  );
}

function selection(
  cohort: NormalizedCohort,
  cohortStatus: AttendanceCohortStatus,
): AttendanceCohortSelection {
  return {
    cohortId: cohortStatus === "active" ? cohort.id : null,
    cohortStatus,
    cohortStartDate: cohort.startDate,
    cohortEndDate: cohort.endDate,
  };
}

function compareActive(
  left: NormalizedCohort,
  right: NormalizedCohort,
): number {
  if (left.endDate !== right.endDate) {
    if (left.endDate === null) {
      return 1;
    }
    if (right.endDate === null) {
      return -1;
    }
    return left.endDate.localeCompare(right.endDate);
  }
  return (
    right.startDate.localeCompare(left.startDate) ||
    left.id.localeCompare(right.id)
  );
}

function compareUpcoming(
  left: NormalizedCohort,
  right: NormalizedCohort,
): number {
  if (left.endDate !== right.endDate) {
    if (left.endDate === null) {
      return 1;
    }
    if (right.endDate === null) {
      return -1;
    }
    const byEndDate = left.endDate.localeCompare(right.endDate);
    if (byEndDate !== 0) {
      return byEndDate;
    }
  }
  return (
    left.startDate.localeCompare(right.startDate) ||
    left.id.localeCompare(right.id)
  );
}
