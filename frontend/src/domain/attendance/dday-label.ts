import type {DdayPeriod} from './dday-progress';

const DAY_MS = 24 * 60 * 60 * 1000;
const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;

export interface DdayAttendanceSnapshot {
    cohortStatus: string;
    cohortStartDate: string | null;
    cohortEndDate: string | null;
}

export function dashboardDdayPeriod(
    snapshot: Pick<DdayAttendanceSnapshot, 'cohortStartDate' | 'cohortEndDate'>,
): DdayPeriod | null {
    const start = calendarTimestamp(snapshot.cohortStartDate);
    const end = calendarTimestamp(snapshot.cohortEndDate);
    if (start === null || end === null || end < start) return null;
    return {
        startDate: snapshot.cohortStartDate!,
        endDate: snapshot.cohortEndDate!,
    };
}

export function dashboardDdayLabel(
    snapshot: DdayAttendanceSnapshot,
    today: string,
): string | null {
    const period = dashboardDdayPeriod(snapshot);
    const todayTimestamp = calendarTimestamp(today);
    if (!period || todayTimestamp === null) return null;
    const startTimestamp = calendarTimestamp(period.startDate)!;
    const endTimestamp = calendarTimestamp(period.endDate)!;
    if (snapshot.cohortStatus === 'ended' || todayTimestamp > endTimestamp) return '과정 종료';
    if (snapshot.cohortStatus === 'upcoming' || todayTimestamp < startTimestamp) {
        return `시작까지 D-${Math.max(0, Math.round((startTimestamp - todayTimestamp) / DAY_MS))}`;
    }
    return `수료까지 D-${Math.max(0, Math.round((endTimestamp - todayTimestamp) / DAY_MS))}`;
}

function calendarTimestamp(value: string | null): number | null {
    if (value === null) return null;
    const match = CALENDAR_DATE.exec(value);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const timestamp = Date.UTC(year, month - 1, day);
    const parsed = new Date(timestamp);
    return parsed.getUTCFullYear() === year
        && parsed.getUTCMonth() === month - 1
        && parsed.getUTCDate() === day
        ? timestamp
        : null;
}
