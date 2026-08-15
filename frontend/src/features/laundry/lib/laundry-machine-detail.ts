import type {DashboardLaundryMachine} from '@/domain/laundry/capacity';
import {
    laundryAvailabilityState,
    laundryOperationLabel,
    laundryProgress,
    laundryRemainingText,
    laundryStartAt,
    type LaundryStatusAppliance,
} from '@/domain/laundry/status';
import {
    washTowerHeading,
    type WashTowerApplianceKind,
} from './wash-tower';
import {
    laundryZonePresentation,
    type LaundryZone,
} from '@/components/dashboard/laundry-zone-presentation';

export type LaundryApplianceTone =
    | 'active'
    | 'available'
    | 'confirming'
    | 'error'
    | 'neutral'
    | 'warning';

export interface LaundryApplianceDetailView {
    kind: WashTowerApplianceKind;
    label: string;
    statusLabel: string;
    tone: LaundryApplianceTone;
    remainingLabel: string;
    totalLabel: string | null;
    progress: number | null;
    startedAt: string | null;
    estimatedFinishAt: string | null;
    errorCode: string | null;
    helpText: string | null;
    estimated: boolean;
}

export interface LaundryMachineDetailView {
    id: string;
    title: string;
    zone: LaundryZone;
    zoneLabel: string;
    washer: LaundryApplianceDetailView;
    dryer: LaundryApplianceDetailView;
}

const PROJECTION_STATUS_LABELS: Readonly<Record<string, string>> = {
    OBSERVED: '작동 중',
    ESTIMATED_RUNNING: '작동 중',
    AWAITING_COMPLETION_CONFIRMATION: '완료 확인 중',
    CONFIRMED_COMPLETED: '사용 가능',
    PAUSED: '일시 정지',
    ERROR: '오류',
    IDLE: '사용 가능',
    UNKNOWN: '확인 불가',
};

const COMPLETION_CONFIRMATION_HELP_TEXT =
    '보정 시간은 끝났지만 LG ThinQ API의 완료 확인을 기다리는 중입니다.';

function validDateTime(value?: string | null): string | null {
    return value && Number.isFinite(Date.parse(value)) ? value : null;
}

function validStartedAt(
    appliance: LaundryStatusAppliance | null | undefined,
    nowMs: number,
): string | null {
    const value = laundryStartAt(appliance);
    if (!value) return null;
    const timestamp = Date.parse(value);
    const earliestCurrentSession = nowMs - 24 * 60 * 60 * 1_000;
    const latestPlausibleStart = nowMs + 5 * 60 * 1_000;
    return timestamp >= earliestCurrentSession && timestamp <= latestPlausibleStart
        ? value
        : null;
}

function normalizedErrorCode(appliance?: LaundryStatusAppliance | null): string | null {
    const value = appliance?.errorCode?.trim().toUpperCase();
    return value || null;
}

function applianceStatus(
    appliance: LaundryStatusAppliance | null | undefined,
): Pick<LaundryApplianceDetailView, 'helpText' | 'statusLabel' | 'tone'> {
    if (!appliance) {
        return {statusLabel: '정보 없음', tone: 'neutral', helpText: null};
    }

    const availability = laundryAvailabilityState(appliance);
    const errorCode = normalizedErrorCode(appliance);
    if (availability === 'error') {
        const plumbingError = errorCode === 'EMPTY_WATER_ALERT_ERROR';
        return {
            statusLabel: plumbingError ? '배관 에러' : '오류',
            tone: 'error',
            helpText: plumbingError
                ? '필터 청소 후 기기 상태를 확인하세요.'
                : '기기 오류. 기기 상태를 확인하세요.',
        };
    }

    if (availability === 'available') {
        return {statusLabel: '사용 가능', tone: 'available', helpText: null};
    }

    const projectionStatus = appliance.projection?.status ?? '';
    if (projectionStatus === 'AWAITING_COMPLETION_CONFIRMATION') {
        return {
            statusLabel: '완료 확인 중',
            tone: 'confirming',
            helpText: COMPLETION_CONFIRMATION_HELP_TEXT,
        };
    }

    const warning = projectionStatus === 'PAUSED'
        || appliance.operationalStatus === 'PAUSED'
        || appliance.state?.code === 'PAUSE';
    if (warning) {
        return {
            statusLabel: laundryOperationLabel(appliance) ?? '일시 정지',
            tone: 'warning',
            helpText: null,
        };
    }

    if (appliance.operationalStatus === 'SCHEDULED') {
        return {statusLabel: '예약됨', tone: 'active', helpText: null};
    }

    return {
        statusLabel: laundryOperationLabel(appliance)
            ?? PROJECTION_STATUS_LABELS[projectionStatus]
            ?? '작동 중',
        tone: projectionStatus === 'UNKNOWN' ? 'neutral' : 'active',
        helpText: null,
    };
}

function applianceRemainingLabel(
    appliance: LaundryStatusAppliance | null | undefined,
    tone: LaundryApplianceTone,
    nowMs: number,
): string {
    if (!appliance) return '확인 불가';
    if (tone === 'available') return '사용 가능';
    if (tone === 'error') return '확인 필요';

    const remaining = laundryRemainingText(appliance, nowMs);
    if (remaining === '--') return '시간 확인 중';
    if (remaining === '예약') return '예약됨';
    return remaining;
}

function totalTimeLabel(appliance?: LaundryStatusAppliance | null): string | null {
    const value = appliance?.totalMinutes;
    return Number.isFinite(value) && (value as number) > 0
        ? `총 ${Math.round(value as number)}분`
        : null;
}

export function laundryApplianceDetail(
    appliance: LaundryStatusAppliance | null | undefined,
    kind: WashTowerApplianceKind,
    nowMs = Date.now(),
): LaundryApplianceDetailView {
    const status = applianceStatus(appliance);
    const progress = status.tone === 'error'
        ? 0
        : status.tone === 'confirming'
            ? 100
            : status.tone === 'active' || status.tone === 'warning'
                ? laundryProgress(appliance, nowMs)
                : null;
    const showSessionTiming = status.tone === 'active'
        || status.tone === 'confirming'
        || status.tone === 'warning';
    const estimated = appliance?.projection?.estimated === true && showSessionTiming;

    return {
        kind,
        label: kind === 'washer' ? '세탁기' : '건조기',
        statusLabel: status.statusLabel,
        tone: status.tone,
        remainingLabel: applianceRemainingLabel(appliance, status.tone, nowMs),
        totalLabel: totalTimeLabel(appliance),
        progress: progress === null ? null : Math.round(progress),
        startedAt: showSessionTiming ? validStartedAt(appliance, nowMs) : null,
        estimatedFinishAt: showSessionTiming ? validDateTime(appliance?.estimatedFinishAt) : null,
        errorCode: normalizedErrorCode(appliance),
        helpText: status.helpText,
        estimated,
    };
}

export function laundryMachineDetail(
    machine: DashboardLaundryMachine,
    nowMs = Date.now(),
): LaundryMachineDetailView {
    const heading = washTowerHeading(machine);
    const numericHeading = /^\d+$/u.test(heading);

    return {
        id: machine.id,
        title: numericHeading ? `${heading}번 워시타워` : heading.replaceAll('_', ' '),
        zone: machine.zone,
        zoneLabel: laundryZonePresentation(machine.zone).label,
        washer: laundryApplianceDetail(machine.washer, 'washer', nowMs),
        dryer: laundryApplianceDetail(machine.dryer, 'dryer', nowMs),
    };
}
