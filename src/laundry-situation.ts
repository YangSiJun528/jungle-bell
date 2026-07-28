import {
    laundryZoneMatchesAccess,
    type LaundryMachineZone,
    type LaundryStatusAppliance,
} from './laundry-status.ts';

export const LAUNDRY_SITUATION_RULES = {
    comfortableStartableRatio: 0.6,
    availableStartableRatio: 0.4,
    maxSnapshotAgeMs: 120_000,
    blockWhenWasherAndDryerActive: true,
    activeOperationalStatuses: [
        'RUNNING',
        'COURSE_RUNNING',
    ],
    activeProjectionStatuses: [
        'OBSERVED',
        'ESTIMATED_RUNNING',
    ],
    pendingDryerLoadOperationalStatuses: [
        'RUNNING',
        'COURSE_RUNNING',
        'PAUSED',
        'SCHEDULED',
        'COMPLETED',
    ],
    pendingDryerLoadProjectionStatuses: [
        'OBSERVED',
        'ESTIMATED_RUNNING',
        'AWAITING_COMPLETION_CONFIRMATION',
        'PAUSED',
        'CONFIRMED_COMPLETED',
    ],
    reliableSourceFreshness: [
        'REFRESH_OBSERVED',
        'WITHIN_REFRESH_WINDOW',
        'UNVERIFIABLE_STABLE',
    ],
} as const;

export type LaundrySituationAccess = 'men' | 'women';
export type LaundrySituationState =
    | 'checking'
    | 'limited'
    | 'dryerBottleneck'
    | 'comfortable'
    | 'available';
export type LaundrySituationRecommendation = 'pending' | 'notRecommended' | 'recommended';

export interface LaundrySituationMachine {
    zone: LaundryMachineZone;
    washer?: LaundryStatusAppliance | null;
    dryer?: LaundryStatusAppliance | null;
}

export interface LaundryAccessSituation {
    access: LaundrySituationAccess;
    total: number;
    washerUsable: number;
    dryerUsable: number;
    activeWashers: number;
    activeDryers: number;
    pendingDryerLoads: number;
    dryerHeadroom: number;
    startableLoads: number;
    washerUsableRatio: number;
    dryerUsableRatio: number;
    startableLoadRatio: number;
    state: LaundrySituationState;
    recommendation: LaundrySituationRecommendation;
}

export interface LaundrySituationDataState {
    hasData: boolean;
    error: unknown;
    sourceFreshness?: string;
    snapshotSavedAt: number | null;
    nowMs: number;
}

const PENDING_DRYER_LOAD_OPERATIONAL_STATUSES = new Set<string>(
    LAUNDRY_SITUATION_RULES.pendingDryerLoadOperationalStatuses,
);
const PENDING_DRYER_LOAD_PROJECTION_STATUSES = new Set<string>(
    LAUNDRY_SITUATION_RULES.pendingDryerLoadProjectionStatuses,
);
const RELIABLE_SOURCE_FRESHNESS = new Set<string>(LAUNDRY_SITUATION_RULES.reliableSourceFreshness);
const ACTIVE_OPERATIONAL_STATUSES = new Set<string>(LAUNDRY_SITUATION_RULES.activeOperationalStatuses);
const ACTIVE_PROJECTION_STATUSES = new Set<string>(LAUNDRY_SITUATION_RULES.activeProjectionStatuses);

function recommendationUsable(appliance?: LaundryStatusAppliance | null): boolean {
    if (
        appliance?.operationalStatus !== 'IDLE'
        || appliance.errorCode
        || appliance.projection?.status === 'ERROR'
    ) {
        return false;
    }
    const projectionStatus = appliance.projection?.status;
    return projectionStatus === undefined || projectionStatus === 'IDLE';
}

function pendingDryerLoad(appliance?: LaundryStatusAppliance | null): boolean {
    return PENDING_DRYER_LOAD_OPERATIONAL_STATUSES.has(appliance?.operationalStatus ?? '')
        || PENDING_DRYER_LOAD_PROJECTION_STATUSES.has(appliance?.projection?.status ?? '');
}

function activeCycle(appliance?: LaundryStatusAppliance | null): boolean {
    return ACTIVE_OPERATIONAL_STATUSES.has(appliance?.operationalStatus ?? '')
        || ACTIVE_PROJECTION_STATUSES.has(appliance?.projection?.status ?? '');
}

export function assessLaundryAccessSituation(
    machines: readonly LaundrySituationMachine[],
    access: LaundrySituationAccess,
    reliable: boolean,
): LaundryAccessSituation {
    const accessible = machines.filter((machine) => laundryZoneMatchesAccess(machine.zone, access));
    const total = accessible.length;
    const washerUsable = accessible.filter((machine) => recommendationUsable(machine.washer)).length;
    const dryerUsable = accessible.filter((machine) => recommendationUsable(machine.dryer)).length;
    const activeWashers = accessible.filter((machine) => activeCycle(machine.washer)).length;
    const activeDryers = accessible.filter((machine) => activeCycle(machine.dryer)).length;
    const pendingDryerLoads = accessible.filter((machine) => pendingDryerLoad(machine.washer)).length;
    const dryerHeadroom = Math.max(0, dryerUsable - pendingDryerLoads);
    const simultaneousCyclesBlocked = LAUNDRY_SITUATION_RULES.blockWhenWasherAndDryerActive
        && activeWashers > 0
        && activeDryers > 0;
    const startableLoads = simultaneousCyclesBlocked
        ? 0
        : Math.min(washerUsable, dryerHeadroom);
    const washerUsableRatio = total === 0 ? 0 : washerUsable / total;
    const dryerUsableRatio = total === 0 ? 0 : dryerUsable / total;
    const startableLoadRatio = total === 0 ? 0 : startableLoads / total;

    const base = {
        access,
        total,
        washerUsable,
        dryerUsable,
        activeWashers,
        activeDryers,
        pendingDryerLoads,
        dryerHeadroom,
        startableLoads,
        washerUsableRatio,
        dryerUsableRatio,
        startableLoadRatio,
    };

    if (!reliable) {
        return {...base, state: 'checking', recommendation: 'pending'};
    }
    if (washerUsable === 0) {
        return {...base, state: 'limited', recommendation: 'notRecommended'};
    }
    if (simultaneousCyclesBlocked || dryerHeadroom === 0) {
        return {...base, state: 'dryerBottleneck', recommendation: 'notRecommended'};
    }
    if (startableLoadRatio >= LAUNDRY_SITUATION_RULES.comfortableStartableRatio) {
        return {...base, state: 'comfortable', recommendation: 'recommended'};
    }
    if (startableLoadRatio >= LAUNDRY_SITUATION_RULES.availableStartableRatio) {
        return {...base, state: 'available', recommendation: 'recommended'};
    }
    return {...base, state: 'limited', recommendation: 'notRecommended'};
}

export function laundrySituationDataIsReliable(state: LaundrySituationDataState): boolean {
    if (
        !state.hasData
        || state.error
        || !RELIABLE_SOURCE_FRESHNESS.has(state.sourceFreshness ?? '')
        || !Number.isFinite(state.snapshotSavedAt)
    ) {
        return false;
    }

    const ageMs = state.nowMs - (state.snapshotSavedAt as number);
    return ageMs >= 0 && ageMs <= LAUNDRY_SITUATION_RULES.maxSnapshotAgeMs;
}
