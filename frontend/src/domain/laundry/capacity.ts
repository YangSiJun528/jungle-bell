import type {LaundryMachineZone, LaundryStatusAppliance} from './status';

export interface DashboardLaundryMachine {
    id: string;
    zone: LaundryMachineZone;
    washer: LaundryStatusAppliance | null;
    dryer: LaundryStatusAppliance | null;
}

export interface LaundryCapacityView {
    men: number | null;
    women: number | null;
}

export interface LaundryCapacityEstimate {
    access: 'men' | 'women';
    washerAvailable: number;
    projectedDryerSupply: number;
    pendingDryerLoads: number;
    dryerHeadroom: number;
    startableLoads: number | null;
    reliable: boolean;
}

export interface LaundryCapacitySnapshot {
    basis: 'WASHER_AND_DRYER_HEADROOM_60_MIN';
    men: LaundryCapacityEstimate;
    women: LaundryCapacityEstimate;
}

/**
 * Projects only server-authoritative counts. Local freshness is an additional
 * fail-closed gate and never triggers a client-side recalculation.
 */
export function laundryCapacity(
    capacity: LaundryCapacitySnapshot | null,
    locallyReliable: boolean,
): LaundryCapacityView {
    return {
        men:
            locallyReliable && capacity?.men.reliable === true ? capacity.men.startableLoads : null,
        women:
            locallyReliable && capacity?.women.reliable === true
                ? capacity.women.startableLoads
                : null,
    };
}
