export type LaundryDashboardStatus =
    | 'running'
    | 'paused'
    | 'awaitingCompletion'
    | 'completed'
    | 'error'
    | 'unavailable';

export interface LaundryDashboardCard {
    machineId: string;
    machineLabel: string;
    appliance: 'washer' | 'dryer';
    sessionId: string;
    notifyBeforeMins: number;
    status: LaundryDashboardStatus;
    totalMinutes: number | null;
    estimatedFinishAt: string | null;
    updatedAt: number | null;
    sourceFreshness: string | null;
}

export interface MealAlertCard {
    id: string;
    period: 'lunch' | 'dinner';
    title: string;
    preview: string;
    dateKey: string;
    publishedAt: string | null;
    createdAt: number;
}

export interface LocalDashboardSnapshot {
    laundry: LaundryDashboardCard | null;
    mealAlerts: MealAlertCard[];
}

export const EMPTY_LOCAL_DASHBOARD: LocalDashboardSnapshot = {
    laundry: null,
    mealAlerts: [],
};

export function laundryDashboardRemaining(card: LaundryDashboardCard, now: number): string {
    if (card.status === 'completed') return '완료';
    if (card.status === 'paused') return '일시 정지';
    if (card.status === 'error') return '오류';
    if (card.status === 'awaitingCompletion') return '완료 확인 중';
    if (card.status === 'unavailable') return '상태 확인 중';

    const finishAt = Date.parse(card.estimatedFinishAt ?? '');
    if (!Number.isFinite(finishAt)) return '종료 시각 확인 중';
    const minutes = Math.max(0, Math.ceil((finishAt - now) / 60_000));
    if (minutes === 0) return '완료 확인 중';
    if (minutes >= 60) return `${Math.floor(minutes / 60)}시간 ${minutes % 60}분 남음`;
    return `${minutes}분 남음`;
}

export function laundryDashboardExpectedEnd(card: LaundryDashboardCard): string {
    const finishAt = Date.parse(card.estimatedFinishAt ?? '');
    if (!Number.isFinite(finishAt)) return '';
    const time = new Intl.DateTimeFormat('ko-KR', {
        timeZone: 'Asia/Seoul',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
    }).format(finishAt);
    return `${time} 예상 종료`;
}

export function laundryDashboardProgress(
    card: LaundryDashboardCard,
    now: number,
): number | null {
    if (card.status === 'completed' || card.status === 'awaitingCompletion') return 100;
    if (card.status !== 'running') return null;

    const totalMinutes = card.totalMinutes;
    const finishAt = Date.parse(card.estimatedFinishAt ?? '');
    if (
        totalMinutes === null
        || !Number.isFinite(totalMinutes)
        || totalMinutes <= 0
        || !Number.isFinite(finishAt)
    ) {
        return null;
    }

    const remainingMinutes = Math.max(0, Math.ceil((finishAt - now) / 60_000));
    const elapsedRatio = (totalMinutes - remainingMinutes) / totalMinutes;
    return Math.round(Math.min(1, Math.max(0, elapsedRatio)) * 100);
}

export function dashboardDataIsStale(
    updatedAt: number | null,
    now: number,
    maxAgeMs: number,
): boolean {
    return updatedAt !== null && Number.isFinite(updatedAt) && now - updatedAt > maxAgeMs;
}

export function laundryDashboardHasSourceWarning(card: LaundryDashboardCard, now: number): boolean {
    return dashboardDataIsStale(card.updatedAt, now, 2 * 60_000)
        || card.sourceFreshness === 'REFRESH_OVERDUE'
        || card.sourceFreshness === 'COLLECTION_GAP';
}
