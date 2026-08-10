import type {
    AttendancePreferences,
    LaundryApplianceKind,
    LaundryQueueEntry,
    LaundryWatch,
    MealPreferences,
} from './dashboard-personal-api';

export type PersonalControlsState = 'loading' | 'auth-required' | 'loaded' | 'error';

export interface LaundryTarget {
    key: string;
    machineId: string;
    appliance: LaundryApplianceKind;
    sessionId: string | null;
    label: string;
}

export interface DashboardPersonalState {
    personalControlsState: PersonalControlsState;
    personalControlsMessage: string;
    attendancePreferences: AttendancePreferences | null;
    attendancePreferencesDirty: boolean;
    attendancePreferencesBusy: boolean;
    mealPreferences: MealPreferences | null;
    mealPreferencesDirty: boolean;
    mealPreferencesBusy: boolean;
    laundryWatches: LaundryWatch[];
    laundryQueue: LaundryQueueEntry[];
    laundryPersonalBusy: boolean;
    laundryPersonalUpdatedAtEpochMs: number | null;
    selectedLaundryTargetKey: string;
}

interface PersonalLaundryAppliance {
    appliance?: LaundryApplianceKind;
    operationalStatus?: string;
    projection?: {status?: string; remainingMinutes?: number} | null;
    remainingMinutes?: number | null;
    sessionId?: string | null;
}

interface PersonalLaundryMachine {
    id: string;
    zone?: string;
    washer: PersonalLaundryAppliance | null;
    dryer: PersonalLaundryAppliance | null;
}

const AVAILABLE_STATES = new Set(['AVAILABLE', 'IDLE', 'READY', 'COMPLETED', 'CONFIRMED_COMPLETED']);
const ACTIVE_STATES = new Set([
    'RUNNING', 'SCHEDULED', 'PAUSED', 'ERROR', 'ESTIMATED_RUNNING',
    'OBSERVED', 'AWAITING_COMPLETION_CONFIRMATION',
]);

export function initialDashboardPersonalState(): DashboardPersonalState {
    return {
        personalControlsState: 'loading',
        personalControlsMessage: '',
        attendancePreferences: null,
        attendancePreferencesDirty: false,
        attendancePreferencesBusy: false,
        mealPreferences: null,
        mealPreferencesDirty: false,
        mealPreferencesBusy: false,
        laundryWatches: [],
        laundryQueue: [],
        laundryPersonalBusy: false,
        laundryPersonalUpdatedAtEpochMs: null,
        selectedLaundryTargetKey: '',
    };
}

export function laundryTargets(machines: readonly PersonalLaundryMachine[]): LaundryTarget[] {
    const targets: LaundryTarget[] = [];
    for (const machine of machines) {
        for (const appliance of ['washer', 'dryer'] as const) {
            const state = machine[appliance];
            if (state === null) continue;
            const active = hasActiveSession(state);
            const sessionId = active && typeof state.sessionId === 'string' ? state.sessionId : null;
            const remaining = state.projection?.remainingMinutes ?? state.remainingMinutes;
            const remainingLabel = active && Number.isFinite(remaining) ? ` · ${Math.max(0, Math.ceil(remaining!))}분 남음` : '';
            const condition = active
                ? '종료 10분 전·완료·사용 가능 전환'
                : '다음 사용 가능 전환';
            targets.push({
                key: `${machine.id}:${appliance}`,
                machineId: machine.id,
                appliance,
                sessionId,
                label: `${machineLabel(machine.id)} · ${applianceLabel(appliance)}${remainingLabel} · ${condition} 알림`,
            });
        }
    }
    return targets;
}

export function hasDuplicateActiveWatch(
    watches: readonly LaundryWatch[],
    target: LaundryTarget,
): boolean {
    return watches.some((watch) => watch.status === 'active'
        && watch.machineId === target.machineId
        && watch.appliance === target.appliance
        && (target.sessionId === null
            ? watch.sessionId === null && watch.notifyWhenAvailable
            : watch.sessionId === target.sessionId));
}

export function hasWaitingQueue(
    entries: readonly LaundryQueueEntry[],
    appliance: LaundryApplianceKind,
): boolean {
    return entries.some((entry) => entry.status === 'waiting' && entry.appliance === appliance);
}

export function watchConditionLabel(watch: LaundryWatch): string {
    if (watch.sessionId === null) {
        return watch.notifyWhenAvailable ? '다음 사용 가능 전환 알림' : '사용 가능 알림 꺼짐';
    }
    const before = watch.notifyBeforeMinutes > 0
        ? `이 동작 종료 ${watch.notifyBeforeMinutes}분 전·완료`
        : '이 동작 완료';
    return watch.notifyWhenAvailable ? `${before}·사용 가능 전환 알림` : `${before} 알림`;
}

export function queueStatusLabel(entry: LaundryQueueEntry): string {
    if (entry.status === 'waiting') return `대기 중 · 현재 ${entry.position ?? '—'}번째`;
    if (entry.status === 'claimed') return '차례 알림 전송됨 · 5분 안내';
    if (entry.status === 'expired') return '차례 안내 시간 만료';
    return '대기 참여 취소';
}

export function applianceLabel(appliance: LaundryApplianceKind): string {
    return appliance === 'washer' ? '세탁기' : '건조기';
}

export function machineLabel(machineId: string): string {
    const match = /(?:워시타워[_\s-]*)?(\d+)$/u.exec(machineId.trim());
    return match?.[1] ? `${match[1]}번` : machineId;
}

function hasActiveSession(appliance: PersonalLaundryAppliance): boolean {
    if (!appliance.sessionId) return false;
    const operational = appliance.operationalStatus ?? '';
    const projection = appliance.projection?.status ?? '';
    if (AVAILABLE_STATES.has(operational) || AVAILABLE_STATES.has(projection)) return false;
    return ACTIVE_STATES.has(operational) || ACTIVE_STATES.has(projection);
}
