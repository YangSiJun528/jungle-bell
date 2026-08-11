import type {DashboardLaundryMachine} from '@/dashboard-model';
import {
    laundryAvailabilityState,
    laundryOperationLabel,
    laundryProgress,
    laundryRemainingText,
    laundryStartAt,
    type LaundryStatusAppliance,
} from '@/laundry-status';
import {
    washTowerHeading,
    type WashTowerApplianceKind,
} from './wash-tower';
import {laundryZoneMeta, type LaundryZone} from './laundry-zone';

export type LaundryApplianceTone = 'active' | 'available' | 'error' | 'neutral' | 'warning';

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

function completionConfirmationDelayed(
    appliance: LaundryStatusAppliance,
    nowMs: number,
): boolean {
    if (appliance.projection?.status !== 'AWAITING_COMPLETION_CONFIRMATION') return false;
    const finishAt = Date.parse(appliance.estimatedFinishAt ?? '');
    return Number.isFinite(finishAt) && nowMs > finishAt;
}

function applianceStatus(
    appliance: LaundryStatusAppliance | null | undefined,
    nowMs: number,
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
                ? '필터를 청소한 뒤 기기 상태를 직접 확인해 주세요.'
                : '기기에 오류가 표시되고 있어요. 기기 상태를 직접 확인해 주세요.',
        };
    }

    if (availability === 'available') {
        return {statusLabel: '사용 가능', tone: 'available', helpText: null};
    }

    if (completionConfirmationDelayed(appliance, nowMs)) {
        return {
            statusLabel: '완료 확인 지연',
            tone: 'warning',
            helpText: '예상 종료 시각이 지났지만 완료 상태가 아직 확인되지 않았어요.',
        };
    }

    const projectionStatus = appliance.projection?.status ?? '';
    if (projectionStatus === 'AWAITING_COMPLETION_CONFIRMATION') {
        return {
            statusLabel: '완료 확인 중',
            tone: 'active',
            helpText: null,
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
    estimated: boolean,
): string {
    if (!appliance) return '상태를 확인할 수 없어요';
    if (tone === 'available') return '바로 사용할 수 있어요';
    if (tone === 'error') return '기기 확인이 필요해요';

    const remaining = laundryRemainingText(appliance, nowMs);
    if (remaining === '--') return '잔여 시간 확인 중';
    if (remaining === '예약') return '예약된 기기예요';
    return `${estimated ? '약 ' : ''}${remaining} 남음`;
}

function totalTimeLabel(appliance?: LaundryStatusAppliance | null): string | null {
    const value = appliance?.totalMinutes;
    return Number.isFinite(value) && (value as number) > 0
        ? `전체 ${Math.round(value as number)}분`
        : null;
}

export function laundryApplianceDetail(
    appliance: LaundryStatusAppliance | null | undefined,
    kind: WashTowerApplianceKind,
    nowMs = Date.now(),
): LaundryApplianceDetailView {
    const status = applianceStatus(appliance, nowMs);
    const progress = status.tone === 'error'
        ? 0
        : status.tone === 'active' || status.tone === 'warning'
            ? laundryProgress(appliance, nowMs)
            : null;
    const showSessionTiming = status.tone === 'active' || status.tone === 'warning';
    const estimated = appliance?.projection?.estimated === true && showSessionTiming;

    return {
        kind,
        label: kind === 'washer' ? '세탁기' : '건조기',
        statusLabel: estimated ? `${status.statusLabel} · 예상` : status.statusLabel,
        tone: status.tone,
        remainingLabel: applianceRemainingLabel(appliance, status.tone, nowMs, estimated),
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
        zoneLabel: laundryZoneMeta(machine.zone).label,
        washer: laundryApplianceDetail(machine.washer, 'washer', nowMs),
        dryer: laundryApplianceDetail(machine.dryer, 'dryer', nowMs),
    };
}
