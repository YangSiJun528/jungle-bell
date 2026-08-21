import type {DashboardMealPost, DashboardWeeklyMealMenu} from '@/api/dashboard-api';
import {mealPeriodLabel, mealServiceDate} from '@/domain/meals/today';

const DAY_MS = 24 * 60 * 60 * 1_000;

export type TodayMealPeriod = '\uC911\uC2DD' | '\uC11D\uC2DD';

export interface TodayMealSlot {
    period: TodayMealPeriod;
    meal: DashboardMealPost | null;
}

const TODAY_MEAL_PERIODS: readonly TodayMealPeriod[] = ['\uC911\uC2DD', '\uC11D\uC2DD'];

export function todayMealSlots(meals: readonly DashboardMealPost[]): TodayMealSlot[] {
    return TODAY_MEAL_PERIODS.map((period) => ({
        period,
        meal: meals.find((meal) => mealPeriodLabel(meal.title) === period) ?? null,
    }));
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

export function weekKeyForDate(dateKey: string): string {
    const [year, month, day] = parseCalendarDate(dateKey);
    const date = new Date(Date.UTC(year, month - 1, day));
    const daysSinceMonday = (date.getUTCDay() + 6) % 7;
    return new Date(date.getTime() - daysSinceMonday * DAY_MS).toISOString().slice(0, 10);
}

export function weeklyMenuForDate(
    weeklyMenus: readonly DashboardWeeklyMealMenu[],
    dateKey: string,
): DashboardWeeklyMealMenu | null {
    const targetWeekKey = weekKeyForDate(dateKey);
    return weeklyMenus.find((menu) => menu.weekKey === targetWeekKey) ?? null;
}

function uniqueMeals(meals: readonly DashboardMealPost[]): DashboardMealPost[] {
    const unique = new Map<string, DashboardMealPost>();
    for (const meal of meals) {
        if (!unique.has(meal.id)) unique.set(meal.id, meal);
    }
    return [...unique.values()];
}

function mealPeriodOrder(title: string | null): number {
    const period = mealPeriodLabel(title);
    if (period === '\uC870\uC2DD') return 0;
    if (period === '\uC911\uC2DD') return 1;
    if (period === '\uC11D\uC2DD') return 2;
    return 3;
}

function compareMealPeriod(left: DashboardMealPost, right: DashboardMealPost): number {
    return mealPeriodOrder(left.title) - mealPeriodOrder(right.title);
}

function calendarDateKey(year: number, month: number, day: number): string | null {
    const value = new Date(Date.UTC(year, month - 1, day));
    if (
        value.getUTCFullYear() !== year ||
        value.getUTCMonth() !== month - 1 ||
        value.getUTCDate() !== day
    )
        return null;
    return value.toISOString().slice(0, 10);
}

function parseCalendarDate(value: string): [number, number, number] {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
    if (!match?.[1] || !match[2] || !match[3]) throw new Error('INVALID_DATE');
    const result: [number, number, number] = [Number(match[1]), Number(match[2]), Number(match[3])];
    if (calendarDateKey(...result) !== value) throw new Error('INVALID_DATE');
    return result;
}
