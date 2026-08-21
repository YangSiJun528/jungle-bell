export type DdayCellState = 'elapsed' | 'current' | 'remaining';

export interface DdayPeriod {
    startDate: string;
    endDate: string;
}

export interface DdayProgressCell {
    key: string;
    label: string;
    state: DdayCellState;
}

export interface DdayProgressRow {
    key: string;
    label: string;
    shortLabel: string;
    cells: Array<DdayProgressCell | null>;
}

export interface DdayProgress {
    rows: DdayProgressRow[];
    total: number;
    elapsed: number;
    remaining: number;
    current: number;
    percent: number;
}

interface ParsedDate {
    year: number;
    month: number;
    day: number;
    timestamp: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const MAX_PERIOD_DAYS = 731;
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function pad(value: number): string {
    return String(value).padStart(2, '0');
}

function isoDate(year: number, month: number, day: number): string {
    return `${year}-${pad(month)}-${pad(day)}`;
}

function parseDate(value: string): ParsedDate | null {
    const match = ISO_DATE_PATTERN.exec(value);
    if (!match) return null;

    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const timestamp = Date.UTC(year, month - 1, day);
    const parsed = new Date(timestamp);
    if (
        parsed.getUTCFullYear() !== year ||
        parsed.getUTCMonth() !== month - 1 ||
        parsed.getUTCDate() !== day
    ) {
        return null;
    }

    return {year, month, day, timestamp};
}

function stateForTimestamp(
    timestamp: number,
    startTimestamp: number,
    endTimestamp: number,
    todayTimestamp: number,
): DdayCellState {
    if (todayTimestamp < startTimestamp) return 'remaining';
    if (todayTimestamp > endTimestamp) return 'elapsed';
    if (timestamp < todayTimestamp) return 'elapsed';
    if (timestamp > todayTimestamp) return 'remaining';
    return 'current';
}

function summarize(rows: DdayProgressRow[], percent: number): DdayProgress {
    const cells = rows.flatMap((row) =>
        row.cells.filter((cell): cell is DdayProgressCell => cell !== null),
    );
    let elapsed = 0;
    let remaining = 0;
    let current = 0;
    for (const cell of cells) {
        if (cell.state === 'elapsed') elapsed += 1;
        if (cell.state === 'remaining') remaining += 1;
        if (cell.state === 'current') current += 1;
    }

    return {
        rows,
        total: cells.length,
        elapsed,
        remaining,
        current,
        percent,
    };
}

function calendarRows(start: ParsedDate, end: ParsedDate, today: ParsedDate): DdayProgressRow[] {
    const startMonthIndex = start.year * 12 + start.month - 1;
    const endMonthIndex = end.year * 12 + end.month - 1;

    return Array.from({length: endMonthIndex - startMonthIndex + 1}, (_, index) => {
        const monthIndex = startMonthIndex + index;
        const year = Math.floor(monthIndex / 12);
        const month = (monthIndex % 12) + 1;

        return {
            key: `${year}-${pad(month)}`,
            label: `${year}년 ${month}월`,
            shortLabel: `${month}월`,
            cells: Array.from({length: 31}, (_unusedCell, dayIndex) => {
                const day = dayIndex + 1;
                const timestamp = Date.UTC(year, month - 1, day);
                const date = new Date(timestamp);
                const isValidDate =
                    date.getUTCFullYear() === year &&
                    date.getUTCMonth() === month - 1 &&
                    date.getUTCDate() === day;
                if (!isValidDate || timestamp < start.timestamp || timestamp > end.timestamp) {
                    return null;
                }

                return {
                    key: isoDate(year, month, day),
                    label: `${year}년 ${month}월 ${day}일`,
                    state: stateForTimestamp(
                        timestamp,
                        start.timestamp,
                        end.timestamp,
                        today.timestamp,
                    ),
                };
            }),
        };
    });
}

function progressPercent(
    startTimestamp: number,
    totalDays: number,
    todayTimestamp: number,
): number {
    const completedDays = Math.min(
        totalDays,
        Math.max(0, Math.round((todayTimestamp - startTimestamp) / DAY_MS)),
    );
    return Math.round((completedDays / totalDays) * 1_000) / 10;
}

export function kstDateString(timestamp = Date.now()): string {
    return new Date(timestamp + KST_OFFSET_MS).toISOString().slice(0, 10);
}

export function buildDdayProgress(
    period: DdayPeriod,
    todayValue = kstDateString(),
): DdayProgress | null {
    const start = parseDate(period.startDate);
    const end = parseDate(period.endDate);
    const today = parseDate(todayValue);
    if (!start || !end || !today || end.timestamp < start.timestamp) return null;

    const totalDays = Math.round((end.timestamp - start.timestamp) / DAY_MS) + 1;
    if (totalDays > MAX_PERIOD_DAYS) return null;

    const percent = progressPercent(start.timestamp, totalDays, today.timestamp);
    return summarize(calendarRows(start, end, today), percent);
}
