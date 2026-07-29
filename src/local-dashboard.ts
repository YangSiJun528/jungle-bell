import {notificationTimeLabel} from './notification-inbox.ts';

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

export type LaundryTerminalStatus =
    | 'completed'
    | 'error'
    | 'needsCheck'
    | 'replaced';

export interface LaundryTerminalActivity {
    id: string;
    machineId: string;
    machineLabel: string;
    appliance: 'washer' | 'dryer';
    sessionId: string;
    status: LaundryTerminalStatus;
    finishedAt: number;
}

export interface LocalDashboardSnapshot {
    laundry: LaundryDashboardCard | null;
    laundryTerminalActivities: LaundryTerminalActivity[];
}

export const EMPTY_LOCAL_DASHBOARD: LocalDashboardSnapshot = {
    laundry: null,
    laundryTerminalActivities: [],
};

export type LaundryTerminalTone = 'success' | 'danger' | 'warning' | 'neutral';

function laundryActionLabel(activity: LaundryTerminalActivity): string {
    return activity.appliance === 'washer' ? '세탁' : '건조';
}

function laundryDeviceLabel(activity: LaundryTerminalActivity): string {
    return activity.appliance === 'washer' ? '세탁기' : '건조기';
}

export function laundryTerminalActivityTitle(
    activity: LaundryTerminalActivity,
): string {
    const action = laundryActionLabel(activity);
    if (activity.status === 'completed') return `${action} 완료`;
    if (activity.status === 'error') return `${laundryDeviceLabel(activity)} 오류`;
    if (activity.status === 'needsCheck') return `${action} 상태 확인`;
    return `${action} 추적 종료`;
}

export function laundryTerminalActivityDetail(
    activity: LaundryTerminalActivity,
): string {
    const machine = activity.machineLabel;
    const device = laundryDeviceLabel(activity);
    if (activity.status === 'completed') {
        return `${machine} ${device}의 세탁물을 꺼냈다면 목록에서 제거해 주세요.`;
    }
    if (activity.status === 'error') {
        return `${machine} ${device} 상태를 확인한 뒤 목록에서 제거해 주세요.`;
    }
    if (activity.status === 'needsCheck') {
        return `${machine} ${device}가 끝났거나 중단됐습니다. 상태를 확인해 주세요.`;
    }
    return `${machine} ${device}에서 다른 작업이 감지됐습니다. 이전 작업을 확인해 주세요.`;
}

export function laundryTerminalActivityTone(
    activity: LaundryTerminalActivity,
): LaundryTerminalTone {
    if (activity.status === 'completed') return 'success';
    if (activity.status === 'error') return 'danger';
    if (activity.status === 'needsCheck') return 'warning';
    return 'neutral';
}

export function laundryTerminalActivityTime(
    activity: LaundryTerminalActivity,
    now = Date.now(),
): string {
    const label = notificationTimeLabel(activity.finishedAt, now);
    if (!label) return '';
    return label.includes(':') ? `${label} 감지` : label;
}

export function laundryTerminalActivityDateTime(
    activity: LaundryTerminalActivity,
): string {
    if (!Number.isFinite(activity.finishedAt)) return '';
    const date = new Date(activity.finishedAt);
    return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

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
