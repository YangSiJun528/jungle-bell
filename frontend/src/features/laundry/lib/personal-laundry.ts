import type {
    LaundryApplianceKind,
    LaundryNotificationMode,
    LaundryWatch,
    LaundryWatchInput,
} from '@/api/personal-api';

export interface LaundryTarget {
    key: string;
    machineId: string;
    appliance: LaundryApplianceKind;
    sessionId: string | null;
    label: string;
}

interface PersonalLaundryAppliance {
    appliance?: LaundryApplianceKind;
    operationalStatus?: string;
    projection?: {status?: string; remainingMinutes?: number | null} | null;
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
            targets.push({
                key: `${machine.id}:${appliance}`,
                machineId: machine.id,
                appliance,
                sessionId,
                label: `${machineLabel(machine.id)} · ${applianceLabel(appliance)}${remainingLabel}`,
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
        && watch.sessionId === target.sessionId);
}

export function watchConditionLabel(watch: LaundryWatch): string {
    switch (watch.notificationMode) {
        case 'before-completion':
            return `${watch.notifyBeforeMinutes}분 남았을 때 알림`;
        case 'estimated-completion':
            return '완료 예상 시점 알림';
        case 'confirmed-completion':
            return '완료 확정 시점 알림';
    }
}

export function buildLaundryWatchInput(
    target: LaundryTarget,
    notificationMode: LaundryNotificationMode,
    notifyBeforeMinutes: number,
): LaundryWatchInput {
    if (target.sessionId === null) throw new Error('LAUNDRY_SESSION_REQUIRED');
    return {
        machineId: target.machineId,
        appliance: target.appliance,
        sessionId: target.sessionId,
        notificationMode,
        notifyBeforeMinutes: notificationMode === 'before-completion' ? notifyBeforeMinutes : 0,
    };
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
