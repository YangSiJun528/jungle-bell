export type LaundryAvailabilityState = 'available' | 'error' | 'unavailable';
export type LaundryAccess = 'all' | 'men' | 'women';
export type LaundryMachineZone = 'men' | 'common' | 'women' | 'other';
export const UNKNOWN_LAUNDRY_STARTED_AT = '1970-01-01T00:00:00.000Z';

export interface LaundryStatusAppliance {
    appliance?: string;
    operationalStatus?: string;
    projection?: {status?: string; remainingMinutes?: number} | null;
    state?: {code?: string; labelKo?: string} | null;
    startedAt?: string | null;
    estimatedFinishAt?: string | null;
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

const LG_STATE_LABELS: Record<string, string> = {
    POWER_OFF: '전원 꺼짐', INITIAL: '사용 가능', RESERVED: '예약됨', DETECTING: '세탁량 감지 중',
    DISPENSING: '세제 투입 중', SOAKING: '불림 중', WASHING: '세탁 중', RINSING: '헹굼 중',
    SPINNING: '탈수 중', DRYING: '건조 중', COOLING: '식힘 중', REFRESHING: '리프레시 중',
    WRINKLE_CARE: '구김 방지 중', PAUSE: '일시 정지', END: '완료', ERROR: '오류', UNKNOWN: '알 수 없음',
};

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

export function laundryOverviewText(appliance?: LaundryStatusAppliance | null): string {
    const state = laundryAvailabilityState(appliance);
    if (state === 'available') return '';
    if (state === 'error') return 'ERROR';

    const remainingMinutes = appliance?.projection?.remainingMinutes;
    if (!Number.isFinite(remainingMinutes)) return '--:--';
    const totalMinutes = Math.max(0, Math.ceil(remainingMinutes as number));
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

export function laundryRemainingText(appliance?: LaundryStatusAppliance | null): string {
    if (!appliance) return '--';
    const status = appliance.projection?.status;
    if (status === 'CONFIRMED_COMPLETED') return '완료';
    if (status === 'ERROR') return '오류';
    if (status === 'IDLE') return appliance.operationalStatus === 'SCHEDULED' ? '예약' : '사용 가능';
    if (status === 'UNKNOWN') return '--';
    const minutes = appliance.projection?.remainingMinutes;
    if (!Number.isFinite(minutes)) return '--';
    const value = minutes as number;
    if (value >= 60) {
        const hours = Math.floor(value / 60);
        const rest = value % 60;
        return rest ? `${hours}시간 ${rest}분` : `${hours}시간`;
    }
    return `${value}분`;
}

export function laundryStartAt(appliance?: LaundryStatusAppliance | null): string {
    const startedAt = appliance?.startedAt;
    return startedAt && Number.isFinite(Date.parse(startedAt)) ? startedAt : UNKNOWN_LAUNDRY_STARTED_AT;
}

export function laundryOperationLabel(appliance?: LaundryStatusAppliance | null): string | undefined {
    const code = appliance?.state?.code;
    if (code === 'RUNNING') {
        if (appliance?.appliance === 'washer') return '세탁 중';
        if (appliance?.appliance === 'dryer') return '건조 중';
    }
    return appliance?.state?.labelKo ?? LG_STATE_LABELS[code ?? ''];
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
