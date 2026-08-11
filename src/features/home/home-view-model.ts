import type {
    AttendanceDashboard,
    AttendanceData,
    DashboardLaundrySnapshot,
    DashboardMealPost,
    DashboardMealsSnapshot,
} from '@/dashboard-api';
import {laundryCapacity} from '@/dashboard-model';
import {laundrySituationDataIsReliable} from '@/laundry-situation';
import {
    mealPeriodLabel as sharedMealPeriodLabel,
    selectMealSections,
} from '@/features/meals/lib/meal-view';
import {kstDateString} from '@/dday-progress';

export type HomeQueryState = 'pending' | 'error' | 'ready';

export interface LaundryHomeSummary {
    men: number | null;
    women: number | null;
}

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
    return selectMealSections(snapshot, reference).today.slice(0, 4);
}

export function mealPeriodLabel(meal: Pick<DashboardMealPost, 'title'>): string {
    return sharedMealPeriodLabel(meal.title);
}
