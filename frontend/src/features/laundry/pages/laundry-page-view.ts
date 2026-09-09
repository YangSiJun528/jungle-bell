import type {DashboardLaundrySnapshot} from '@/api/dashboard-api';
import type {LaundryCapacityEstimate, LaundryCapacitySnapshot} from '@/domain/laundry/capacity';
import {laundryCapacity} from '@/domain/laundry/capacity';
import {laundrySituationDataIsReliable} from '@/domain/laundry/freshness';
import {relativeTimeLabel} from '@/lib/format';

export interface CapacityCardView {
    access: LaundryCapacityEstimate['access'];
    count: number | null;
    description: string;
    label: string;
    status: 'available' | 'full' | 'checking';
}

export interface LaundrySummaryCounts {
    men: number | null;
    women: number | null;
}

export type LaundryPageStateKind =
    | 'loading'
    | 'normal'
    | 'empty'
    | 'stale'
    | 'offline'
    | 'error'
    | 'recovered';

export type LaundryPageStateReason =
    | 'offline'
    | 'refresh-failed'
    | 'collector-unavailable'
    | 'collection-incomplete'
    | 'source-stale'
    | 'no-machines'
    | 'recovered'
    | null;

export interface LaundryPageStatus {
    kind: LaundryPageStateKind;
    title: string;
    message: string;
    reason: LaundryPageStateReason;
    retryLabel: string;
    lastKnownAt: string | null;
    lastKnownLabel: string;
    canRetry: boolean;
    allowWatchCreation: boolean;
}

export interface LaundryPageReliabilityFlags {
    hasData: boolean;
    isCollectorHealthy: boolean;
    isCollectionSuccess: boolean;
    isFreshEnough: boolean;
}

function snapshotReliabilityFlags(input: {
    snapshot: DashboardLaundrySnapshot;
    nowMs: number;
}): LaundryPageReliabilityFlags {
    const freshness = laundrySituationDataIsReliable({
        hasData: input.snapshot.machines.length > 0,
        error: null,
        sourceFreshness: input.snapshot.quality.sourceFreshness,
        expectedRefreshIntervalSeconds: input.snapshot.quality.expectedRefreshIntervalSeconds,
        snapshotSavedAt: Date.parse(input.snapshot.asOf),
        nowMs: input.nowMs,
    });

    return {
        hasData: input.snapshot.machines.length > 0,
        isCollectorHealthy: input.snapshot.quality.collectorHealthy,
        isCollectionSuccess: input.snapshot.quality.collection === 'SUCCESS',
        isFreshEnough: freshness,
    };
}

export function laundrySummaryFromSnapshot(input: {
    snapshot: DashboardLaundrySnapshot;
    nowMs?: number;
}): LaundrySummaryCounts {
    const snapshotTime = Date.parse(input.snapshot.quality.lastCheckedAt ?? input.snapshot.asOf);
    return laundryCapacity(
        input.snapshot.capacity,
        isLaundrySnapshotReliable({
            snapshot: input.snapshot,
            nowMs: input.nowMs ?? (Number.isFinite(snapshotTime) ? snapshotTime : Date.now()),
        }),
    );
}

function isLaundrySnapshotReliable(input: {
    snapshot: DashboardLaundrySnapshot;
    nowMs: number;
}): boolean {
    const flags = snapshotReliabilityFlags({snapshot: input.snapshot, nowMs: input.nowMs});
    return (
        flags.hasData &&
        flags.isCollectorHealthy &&
        flags.isCollectionSuccess &&
        flags.isFreshEnough
    );
}

function lastKnownAtLabel(snapshot: DashboardLaundrySnapshot, nowMs: number): string {
    const lastChecked = snapshot.quality.lastCheckedAt ?? snapshot.asOf;
    return relativeTimeLabel(lastChecked, nowMs);
}

export function laundryPageState(input: {
    snapshot: DashboardLaundrySnapshot | null;
    nowMs?: number;
    isPending?: boolean;
    isOffline?: boolean;
    queryError: unknown;
    manualRefreshError: unknown;
    recovered?: boolean;
}): LaundryPageStatus {
    if (!input.snapshot) {
        const kind: LaundryPageStateKind = input.isOffline
            ? 'offline'
            : input.queryError || input.manualRefreshError
              ? 'error'
              : input.isPending === false
                ? 'empty'
                : 'loading';

        return {
            kind,
            title:
                kind === 'offline'
                    ? '현재 오프라인 상태입니다.'
                    : kind === 'error'
                      ? '세탁실 상태를 불러오지 못했습니다.'
                      : kind === 'empty'
                        ? '표시할 세탁실 정보가 없습니다.'
                        : '세탁 상태를 불러오는 중입니다.',
            message:
                kind === 'offline'
                    ? '인터넷 연결 후 다시 시도해 주세요.'
                    : kind === 'error'
                      ? '연결 상태를 확인하고 다시 시도해 주세요.'
                      : kind === 'empty'
                        ? '수집된 기기 데이터가 없습니다.'
                        : '세탁실 상태를 불러오는 중입니다.',
            reason: kind === 'offline' ? 'offline' : kind === 'error' ? 'refresh-failed' : null,
            retryLabel: '새로고침',
            lastKnownAt: null,
            lastKnownLabel: '확인 기록 없음',
            canRetry: kind === 'error',
            allowWatchCreation: false,
        };
    }

    const snapshotTime = Date.parse(input.snapshot.quality.lastCheckedAt ?? input.snapshot.asOf);
    const nowMs = input.nowMs ?? (Number.isFinite(snapshotTime) ? snapshotTime : Date.now());
    const backgroundError = Boolean(input.queryError || input.manualRefreshError);
    const collectorUnavailable = !input.snapshot.quality.collectorHealthy;
    const collectionIncomplete = input.snapshot.quality.collection !== 'SUCCESS';
    const sourceStale =
        input.snapshot.machines.length > 0 &&
        !snapshotReliabilityFlags({snapshot: input.snapshot, nowMs}).isFreshEnough;

    let kind: LaundryPageStateKind = 'normal';
    let title = '세탁실 상태를 표시합니다.';
    let message = '실시간 상태를 확인했습니다.';
    let reason: LaundryPageStateReason = null;

    if (input.isOffline) {
        kind = 'offline';
        title = '현재 오프라인 상태입니다.';
        message = '인터넷 연결이 없어 마지막 정상 데이터를 표시합니다. 실시간 정보가 아닙니다.';
        reason = 'offline';
    } else if (backgroundError) {
        kind = 'stale';
        title = '최신 세탁실 상태를 불러오지 못했습니다.';
        message = '조회 실패로 마지막 정상 데이터를 표시합니다. 실시간 정보가 아닙니다.';
        reason = 'refresh-failed';
    } else if (collectorUnavailable) {
        kind = 'stale';
        title = '세탁실 수집 서버에 문제가 있습니다.';
        message = '수집 서버 문제로 마지막 정상 데이터를 표시합니다. 실시간 정보가 아닙니다.';
        reason = 'collector-unavailable';
    } else if (collectionIncomplete) {
        kind = 'stale';
        title = '세탁실 수집이 완료되지 않았습니다.';
        message = '일부 수집이 완료되지 않아 실시간 정보가 아닙니다.';
        reason = 'collection-incomplete';
    } else if (sourceStale) {
        kind = 'stale';
        title = '세탁실 상태가 늦게 반영됩니다.';
        message = '수집이 지연되어 실시간 정보가 아닙니다.';
        reason = 'source-stale';
    } else if (input.snapshot.machines.length === 0) {
        kind = 'empty';
        title = '표시할 워시타워가 없습니다.';
        message = '현재 표시할 기기 데이터가 없습니다.';
        reason = 'no-machines';
    } else if (input.recovered) {
        kind = 'recovered';
        title = '세탁실 상태가 복구되었습니다.';
        message = '이전 조회 문제에서 정상 조회로 전환되었습니다.';
        reason = 'recovered';
    }

    const allowsCreation =
        input.snapshot.machines.length > 0 && (kind === 'normal' || kind === 'recovered');

    return {
        kind,
        title,
        message,
        reason,
        retryLabel: '새로고침',
        lastKnownAt: input.snapshot.quality.lastCheckedAt ?? input.snapshot.asOf,
        lastKnownLabel: lastKnownAtLabel(input.snapshot, nowMs),
        canRetry: kind === 'stale',
        allowWatchCreation: allowsCreation,
    };
}

export function capacityCards(
    capacity: LaundryCapacitySnapshot | null,
    snapshotReliable: boolean,
): CapacityCardView[] {
    return (['men', 'women'] as const).map((access) => {
        const estimate = capacity?.[access] ?? null;
        const count =
            snapshotReliable && estimate?.reliable === true ? estimate.startableLoads : null;
        return {
            access,
            count,
            label: access === 'men' ? '남성 가능' : '여성 가능',
            status: count === null ? 'checking' : count > 0 ? 'available' : 'full',
            description:
                count === null
                    ? '최신 기기 상태 확인 중'
                    : count > 0
                      ? `건조 여유 포함 · ${count}회 시작 가능`
                      : '건조기 여유 부족',
        };
    });
}
