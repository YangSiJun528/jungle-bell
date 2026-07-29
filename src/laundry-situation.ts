import {
    laundryAvailabilityState,
    laundryZoneMatchesAccess,
    type LaundryMachineZone,
    type LaundryStatusAppliance,
} from './laundry-status.ts';

export const LAUNDRY_SITUATION_RULES = {
    forecastWindowMinutes: 60,
    comfortableStartableLoads: 2,
    availableStartableLoads: 1,
    maxSnapshotAgeMs: 120_000,
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
    ],
    pendingDryerLoadProjectionStatuses: [
        'OBSERVED',
        'ESTIMATED_RUNNING',
        'AWAITING_COMPLETION_CONFIRMATION',
        'PAUSED',
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
    return laundryAvailabilityState(appliance) === 'available';
}

function pendingDryerLoad(appliance?: LaundryStatusAppliance | null): boolean {
    if (!appliance || recommendationUsable(appliance) || laundryAvailabilityState(appliance) === 'error') {
        return false;
    }
    return PENDING_DRYER_LOAD_OPERATIONAL_STATUSES.has(appliance?.operationalStatus ?? '')
        || PENDING_DRYER_LOAD_PROJECTION_STATUSES.has(appliance?.projection?.status ?? '');
}

function activeCycle(appliance?: LaundryStatusAppliance | null): boolean {
    return ACTIVE_OPERATIONAL_STATUSES.has(appliance?.operationalStatus ?? '')
        || ACTIVE_PROJECTION_STATUSES.has(appliance?.projection?.status ?? '');
}

function projectedRemainingMinutes(
    appliance: LaundryStatusAppliance | null | undefined,
    nowMs: number,
): number | null {
    const finishAt = Date.parse(appliance?.estimatedFinishAt ?? '');
    if (Number.isFinite(finishAt)) {
        return Math.max(0, Math.ceil((finishAt - nowMs) / 60_000));
    }

    const remainingMinutes = appliance?.projection?.remainingMinutes;
    return Number.isFinite(remainingMinutes)
        ? Math.max(0, Math.ceil(remainingMinutes as number))
        : null;
}

function dryerAvailableWithinForecast(
    appliance: LaundryStatusAppliance | null | undefined,
    nowMs: number,
): boolean {
    if (!appliance || recommendationUsable(appliance) || laundryAvailabilityState(appliance) === 'error') {
        return false;
    }

    const projectionStatus = appliance.projection?.status;
    if (
        projectionStatus === 'AWAITING_COMPLETION_CONFIRMATION'
        || projectionStatus === 'PAUSED'
        || projectionStatus === 'UNKNOWN'
    ) {
        return false;
    }

    if (!activeCycle(appliance)) return false;
    const remainingMinutes = projectedRemainingMinutes(appliance, nowMs);
    return remainingMinutes !== null
        && remainingMinutes <= LAUNDRY_SITUATION_RULES.forecastWindowMinutes;
}

function washerNeedsDryerWithinForecast(
    appliance: LaundryStatusAppliance | null | undefined,
    nowMs: number,
): boolean {
    if (!pendingDryerLoad(appliance)) return false;

    const operationalStatus = appliance?.operationalStatus;
    const projectionStatus = appliance?.projection?.status;
    if (
        operationalStatus === 'PAUSED'
        || operationalStatus === 'SCHEDULED'
        || projectionStatus === 'AWAITING_COMPLETION_CONFIRMATION'
        || projectionStatus === 'PAUSED'
    ) {
        return true;
    }

    const remainingMinutes = projectedRemainingMinutes(appliance, nowMs);
    return remainingMinutes === null
        || remainingMinutes <= LAUNDRY_SITUATION_RULES.forecastWindowMinutes;
}

export function assessLaundryAccessSituation(
    machines: readonly LaundrySituationMachine[],
    access: LaundrySituationAccess,
    reliable: boolean,
    nowMs = Date.now(),
): LaundryAccessSituation {
    const accessible = machines.filter((machine) => laundryZoneMatchesAccess(machine.zone, access));
    const total = accessible.length;
    const washerUsable = accessible.filter((machine) => recommendationUsable(machine.washer)).length;
    const dryerUsable = accessible.filter((machine) => recommendationUsable(machine.dryer)).length;
    const activeWashers = accessible.filter((machine) => activeCycle(machine.washer)).length;
    const activeDryers = accessible.filter((machine) => activeCycle(machine.dryer)).length;
    const projectedDryerSupply = accessible.filter(
        (machine) => recommendationUsable(machine.dryer)
            || dryerAvailableWithinForecast(machine.dryer, nowMs),
    ).length;
    const pendingDryerLoads = accessible.filter(
        (machine) => washerNeedsDryerWithinForecast(machine.washer, nowMs),
    ).length;
    const dryerHeadroom = Math.max(0, projectedDryerSupply - pendingDryerLoads);
    const startableLoads = Math.min(washerUsable, dryerHeadroom);
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
    if (dryerHeadroom === 0) {
        return {...base, state: 'dryerBottleneck', recommendation: 'notRecommended'};
    }
    if (startableLoads >= LAUNDRY_SITUATION_RULES.comfortableStartableLoads) {
        return {...base, state: 'comfortable', recommendation: 'recommended'};
    }
    if (startableLoads >= LAUNDRY_SITUATION_RULES.availableStartableLoads) {
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
