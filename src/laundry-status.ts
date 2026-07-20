export type LaundryAvailabilityState = 'available' | 'error' | 'unavailable';
export type LaundryAccess = 'all' | 'men' | 'women';
export type LaundryMachineZone = 'men' | 'common' | 'women' | 'other';

export interface LaundryStatusAppliance {
    operationalStatus?: string;
    projection?: {status?: string} | null;
    errorCode?: string | null;
}

export interface LaundryAvailabilitySegment {
    zone: LaundryMachineZone;
    state: LaundryAvailabilityState;
}

export interface LaundryAvailabilitySummary {
    total: number;
    available: number;
}

export function laundryAvailabilityState(
    appliance?: LaundryStatusAppliance | null,
): LaundryAvailabilityState {
    if (!appliance) return 'unavailable';

    const operationalStatus = appliance.operationalStatus;
    const projectionStatus = appliance.projection?.status;
    if (appliance.errorCode || operationalStatus === 'ERROR' || projectionStatus === 'ERROR') {
        return 'error';
    }

    if (projectionStatus) {
        return projectionStatus === 'CONFIRMED_COMPLETED'
            || (projectionStatus === 'IDLE' && operationalStatus !== 'SCHEDULED')
            ? 'available'
            : 'unavailable';
    }

    return operationalStatus === 'IDLE' || operationalStatus === 'COMPLETED'
        ? 'available'
        : 'unavailable';
}

export function laundryZoneMatchesAccess(
    zone: LaundryMachineZone,
    access: LaundryAccess,
): boolean {
    if (access === 'all') return true;
    return zone === access || zone === 'common';
}

export function summarizeLaundryAvailability(
    segments: readonly LaundryAvailabilitySegment[],
    access: LaundryAccess,
): LaundryAvailabilitySummary {
    const accessible = segments.filter((segment) => laundryZoneMatchesAccess(segment.zone, access));
    return {
        total: accessible.length,
        available: accessible.filter((segment) => segment.state === 'available').length,
    };
}
