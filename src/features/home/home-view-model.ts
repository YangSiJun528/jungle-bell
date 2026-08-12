import type {
    AttendanceDashboard,
    AttendanceData,
    DashboardLaundrySnapshot,
    DashboardMealPost,
    DashboardMealsSnapshot,
} from '@/api/dashboard-api';
import {laundryCapacity} from '@/domain/laundry/capacity';
import {laundrySituationDataIsReliable} from '@/domain/laundry/freshness';
import {
    mealPeriodLabel as sharedMealPeriodLabel,
    selectTodayMeals,
} from '@/domain/meals/today';
import {kstDateString} from '@/domain/attendance/dday-progress';

export type HomeQueryState = 'pending' | 'error' | 'ready';

export interface LaundryHomeSummary {
    men: number | null;
    women: number | null;
}

export type HomeMealPeriod = '중식' | '석식';

export interface HomeMealSlot {
    period: HomeMealPeriod;
    meal: DashboardMealPost | null;
}

export type HomeMealSlots = readonly [HomeMealSlot, HomeMealSlot];

type AvailableAttendance = Extract<AttendanceData, {status: 'available'}>;

export function homeAttendanceForToday(
    dashboard?: AttendanceDashboard,
    reference = new Date(),
): AvailableAttendance | null {
    if (!dashboard || dashboard.state !== 'loaded') return null;
    const attendance = dashboard.attendance;
    if (attendance.status !== 'available' || attendance.freshness !== 'fresh') return null;
    if (attendance.snapshot.attendanceDate !== kstDateString(reference.getTime())) return null;
    return attendance;
}

export function homeLaundrySummary(input: {
    queryState: HomeQueryState;
    snapshot?: DashboardLaundrySnapshot;
    nowMs?: number;
}): LaundryHomeSummary {
    if (input.queryState === 'pending') {
        return {men: null, women: null};
    }
    if (input.queryState === 'error' || !input.snapshot) {
        return {men: null, women: null};
    }

    const snapshot = input.snapshot;
    const savedAt = Date.parse(snapshot.asOf);
    const locallyReliable = snapshot.quality.collection === 'SUCCESS'
        && laundrySituationDataIsReliable({
            hasData: snapshot.machines.length > 0,
            error: null,
            sourceFreshness: snapshot.quality.sourceFreshness,
            expectedRefreshIntervalSeconds: snapshot.quality.expectedRefreshIntervalSeconds,
            snapshotSavedAt: savedAt,
            nowMs: input.nowMs ?? Date.now(),
        });
    const capacity = laundryCapacity(snapshot.capacity, locallyReliable);
    return capacity;
}

export function homeTodayMeals(
    snapshot?: DashboardMealsSnapshot,
    reference = new Date(),
): DashboardMealPost[] {
    if (!snapshot) return [];
    return selectTodayMeals(snapshot, reference).slice(0, 4);
}

export function homeTodayMealSlots(
    snapshot?: DashboardMealsSnapshot,
    reference = new Date(),
): HomeMealSlots | null {
    const mealsByPeriod = new Map<HomeMealPeriod, DashboardMealPost>();
    for (const meal of homeTodayMeals(snapshot, reference)) {
        const period = mealPeriodLabel(meal);
        if ((period === '중식' || period === '석식') && !mealsByPeriod.has(period)) {
            mealsByPeriod.set(period, meal);
        }
    }
    if (mealsByPeriod.size === 0) return null;

    const slot = (period: HomeMealPeriod): HomeMealSlot => ({
        period,
        meal: mealsByPeriod.get(period) ?? null,
    });
    return [slot('중식'), slot('석식')];
}

export function mealPeriodLabel(meal: Pick<DashboardMealPost, 'title'>): string {
    return sharedMealPeriodLabel(meal.title);
}
