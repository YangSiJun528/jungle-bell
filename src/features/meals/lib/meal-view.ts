import type {DashboardMealPost, DashboardMealsSnapshot} from '@/dashboard-api';

const KST_OFFSET_MS = 9 * 60 * 60 * 1_000;
const DAY_MS = 24 * 60 * 60 * 1_000;
const TITLED_DATE = /(?:(\d{4})\uB144\s*)?(\d{1,2})\uC6D4\s*(\d{1,2})\uC77C/u;

export interface MealSections {
    today: DashboardMealPost[];
    recent: DashboardMealPost[];
}

export interface CalendarMonthCell {
    date: string;
    day: number;
}

const mealOrder = (title: string | null): number => {
    if (title?.includes('\uC870\uC2DD')) return 0;
    if (title?.includes('\uC911\uC2DD')) return 1;
    if (title?.includes('\uC11D\uC2DD')) return 2;
    return 3;
};

export function mealPeriodLabel(title: string | null): '\uC870\uC2DD' | '\uC911\uC2DD' | '\uC11D\uC2DD' | '\uC2DD\uB2E8' {
    if (title?.includes('\uC870\uC2DD')) return '\uC870\uC2DD';
    if (title?.includes('\uC911\uC2DD')) return '\uC911\uC2DD';
    if (title?.includes('\uC11D\uC2DD')) return '\uC11D\uC2DD';
    return '\uC2DD\uB2E8';
}

export function kstDateKey(reference: Date): string {
    if (!Number.isFinite(reference.getTime())) throw new Error('INVALID_DATE');
    return new Date(reference.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);
}

export function mealServiceDate(meal: DashboardMealPost, reference = new Date()): string | null {
    const timestamp = meal.publishedAt ?? meal.firstSeenAt ?? null;
    const anchor = timestamp ? new Date(timestamp) : reference;
    const validAnchor = Number.isFinite(anchor.getTime()) ? anchor : reference;
    const match = meal.title?.match(TITLED_DATE);
    if (match?.[2] && match[3]) {
        const month = Number(match[2]);
        const day = Number(match[3]);
        const anchorYear = Number(kstDateKey(validAnchor).slice(0, 4));
        const years = match[1]
            ? [Number(match[1])]
            : [anchorYear, anchorYear - 1, anchorYear + 1];
        const candidates = years
            .map((year) => calendarDateKey(year, month, day))
            .filter((value): value is string => value !== null);
        if (candidates.length > 0) {
            const anchorDay = Date.parse(`${kstDateKey(validAnchor)}T00:00:00.000Z`);
            return candidates.reduce((selected, candidate) =>
                Math.abs(Date.parse(`${candidate}T00:00:00.000Z`) - anchorDay)
                    < Math.abs(Date.parse(`${selected}T00:00:00.000Z`) - anchorDay)
                    ? candidate
                    : selected);
        }
    }
    return timestamp && Number.isFinite(new Date(timestamp).getTime())
        ? kstDateKey(new Date(timestamp))
        : null;
}

export function selectMealSections(
    snapshot: DashboardMealsSnapshot,
    reference = new Date(),
): MealSections {
    const todayKey = kstDateKey(reference);
    const allDaily = uniqueMeals([
        ...snapshot.data.dailyMenus,
        ...snapshot.data.recentMenus,
    ]);
    const today = allDaily
        .filter((meal) => mealServiceDate(meal, reference) === todayKey)
        .sort(compareMealPeriod);
    const todayIds = new Set(today.map((meal) => meal.id));
    const recent = allDaily
        .filter((meal) => !todayIds.has(meal.id))
        .sort(compareRecentMeals)
        .slice(0, 30);
    return {today, recent};
}

export function mealsGroupedByDate(
    meals: readonly DashboardMealPost[],
    reference = new Date(),
): Map<string, DashboardMealPost[]> {
    const grouped = new Map<string, DashboardMealPost[]>();
    for (const meal of uniqueMeals(meals)) {
        const date = mealServiceDate(meal, reference);
        if (!date) continue;
        const values = grouped.get(date) ?? [];
        values.push(meal);
        grouped.set(date, values);
    }
    for (const values of grouped.values()) values.sort(compareMealPeriod);
    return grouped;
}

export function calendarMonthCells(monthKey: string): Array<CalendarMonthCell | null> {
    const match = /^(\d{4})-(\d{2})$/u.exec(monthKey);
    if (!match?.[1] || !match[2]) throw new Error('INVALID_MONTH');
    const year = Number(match[1]);
    const month = Number(match[2]);
    if (year < 1900 || year > 2200 || month < 1 || month > 12) throw new Error('INVALID_MONTH');
    const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return Array.from({length: 42}, (_, index) => {
        const day = index - firstWeekday + 1;
        if (day < 1 || day > daysInMonth) return null;
        return {date: calendarDateKey(year, month, day) as string, day};
    });
}

export function shiftMonth(monthKey: string, amount: number): string {
    const cells = calendarMonthCells(monthKey);
    const first = cells.find((cell): cell is CalendarMonthCell => cell !== null);
    if (!first || !Number.isSafeInteger(amount)) throw new Error('INVALID_MONTH');
    const [yearText, monthText] = first.date.split('-');
    const shifted = new Date(Date.UTC(Number(yearText), Number(monthText) - 1 + amount, 1));
    return shifted.toISOString().slice(0, 7);
}

export function monthLabel(monthKey: string): string {
    const first = calendarMonthCells(monthKey).find((cell): cell is CalendarMonthCell => cell !== null);
    if (!first) throw new Error('INVALID_MONTH');
    const [year, month] = first.date.split('-');
    return `${year}\uB144 ${Number(month)}\uC6D4`;
}

export function mealDateLabel(dateKey: string): string {
    const [year, month, day] = parseCalendarDate(dateKey);
    return `${year}\uB144 ${month}\uC6D4 ${day}\uC77C`;
}

export function weekRangeLabel(weekKey: string): string {
    const [year, month, day] = parseCalendarDate(weekKey);
    const start = new Date(Date.UTC(year, month - 1, day));
    const end = new Date(start.getTime() + 6 * DAY_MS);
    return `${start.getUTCMonth() + 1}\uC6D4 ${start.getUTCDate()}\uC77C ~ ${end.getUTCMonth() + 1}\uC6D4 ${end.getUTCDate()}\uC77C`;
}

function uniqueMeals(meals: readonly DashboardMealPost[]): DashboardMealPost[] {
    const unique = new Map<string, DashboardMealPost>();
    for (const meal of meals) {
        if (!unique.has(meal.id)) unique.set(meal.id, meal);
    }
    return [...unique.values()];
}

function compareMealPeriod(left: DashboardMealPost, right: DashboardMealPost): number {
    return mealOrder(left.title) - mealOrder(right.title);
}

function compareRecentMeals(left: DashboardMealPost, right: DashboardMealPost): number {
    const leftTime = Date.parse(left.publishedAt ?? left.firstSeenAt ?? '') || 0;
    const rightTime = Date.parse(right.publishedAt ?? right.firstSeenAt ?? '') || 0;
    return rightTime - leftTime || compareMealPeriod(left, right);
}

function calendarDateKey(year: number, month: number, day: number): string | null {
    const value = new Date(Date.UTC(year, month - 1, day));
    if (value.getUTCFullYear() !== year
        || value.getUTCMonth() !== month - 1
        || value.getUTCDate() !== day) return null;
    return value.toISOString().slice(0, 10);
}

function parseCalendarDate(value: string): [number, number, number] {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
    if (!match?.[1] || !match[2] || !match[3]) throw new Error('INVALID_DATE');
    const result: [number, number, number] = [Number(match[1]), Number(match[2]), Number(match[3])];
    if (calendarDateKey(...result) !== value) throw new Error('INVALID_DATE');
    return result;
}
