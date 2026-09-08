import {RefreshCw, WashingMachine} from 'lucide-react';
import {useId, useState} from 'react';

import {useDashboardEnvironment} from '@/app/dashboard-context';
import {useCampusManualRefresh, useSuspenseLaundryQuery} from '@/app/use-dashboard-queries';
import {AsyncState, useOnlineStatus} from '@/components/dashboard/async-state';
import {laundryZonePresentation} from '@/components/dashboard/laundry-zone-presentation';
import {PageHeader} from '@/components/dashboard/page-header';
import {Button} from '@/components/ui/button';
import {Card, CardContent, CardDescription, CardHeader, CardTitle} from '@/components/ui/card';
import {Label} from '@/components/ui/label';
import {Switch} from '@/components/ui/switch';
import {laundrySituationDataIsReliable} from '@/domain/laundry/freshness';
import {dateTimeLabel, relativeTimeLabel} from '@/lib/format';
import {cn} from '@/lib/utils';

import {LaundryFeatureBoundary} from '../components/laundry-feature-boundary';
import {LaundryMachineList} from '../components/laundry-machine-list';
import {LaundryWarningBadge} from '../components/laundry-warning-badge';
import {LaundryZoneBadge} from '../components/laundry-zone-badge';
import {PersonalLaundrySection} from '../components/personal-laundry-section';
import {WashTowerGrid} from '../components/wash-tower-grid';
import {
    capacityCards,
    laundryPageState,
    type CapacityCardView,
    type LaundryPageStatus,
} from './laundry-page-view';

export {LaundryFeatureBoundary} from '../components/laundry-feature-boundary';

const LAUNDRY_JUMPS = [
    ['요약', 'laundry-capacity-title'],
    ['워시타워', 'laundry-tower-title'],
    ['기기 상세', 'laundry-detail-title'],
    ['내 알림', 'laundry-watch-title'],
] as const;

type LaundryFailureKind = 'error' | 'offline' | 'stale';

function isFailureKind(kind: LaundryPageStatus['kind']): kind is LaundryFailureKind {
    return kind === 'stale' || kind === 'offline' || kind === 'error';
}

function capacityTone(card: CapacityCardView): string {
    if (card.status === 'checking') return 'border-border bg-muted/30';
    return laundryZonePresentation(card.access).surfaceClassName;
}

function staleBanner(status: LaundryPageStatus): string | null {
    if (!isFailureKind(status.kind)) return null;
    return `실시간 정보가 아닙니다. 마지막 정상 시각: ${status.lastKnownLabel}`;
}

const COLLECTOR_UNAVAILABLE_TITLE = '세탁실 수집 서버에 문제가 있습니다.';
const COLLECTOR_UNAVAILABLE_MESSAGE =
    '실시간 상태를 확인할 수 없어 마지막 정상 데이터를 표시합니다.';

function laundryReasonLabel(reason: LaundryPageStatus['reason']): string | undefined {
    if (reason === 'offline') return '네트워크 연결 끊김';
    if (reason === 'refresh-failed') return '최신 세탁실 상태 갱신 실패';
    if (reason === 'collector-unavailable') return '수집 서버 응답 없음';
    if (reason === 'collection-incomplete') return '일부 기기 수집 미완료';
    if (reason === 'source-stale') return '세탁실 데이터 갱신 지연';
    if (reason === 'no-machines') return '수집된 기기 없음';
    if (reason === 'recovered') return '정상 조회 재개';
    return undefined;
}

function LaundryStatusNotice({
    manualRefresh,
    status,
    title,
    message,
}: {
    manualRefresh: ReturnType<typeof useCampusManualRefresh>;
    status: LaundryPageStatus;
    title: string;
    message: string;
}) {
    if (status.kind === 'normal' || status.kind === 'loading') return null;

    if (status.kind === 'empty') {
        return (
            <AsyncState
                type="empty"
                title={title}
                description={message}
                regionLabel="세탁실 데이터 상태"
            />
        );
    }

    if (status.kind === 'error') {
        return (
            <AsyncState
                type="error"
                title={title}
                description={message}
                regionLabel="세탁실 데이터 상태"
                retry={
                    status.canRetry && !manualRefresh.isPending ? manualRefresh.mutate : undefined
                }
                retryLabel={status.retryLabel}
            />
        );
    }

    return (
        <AsyncState
            type={status.kind}
            title={title}
            description={message}
            lastUpdatedAt={status.lastKnownAt ? dateTimeLabel(status.lastKnownAt) : undefined}
            reason={laundryReasonLabel(status.reason)}
            regionLabel="세탁실 데이터 상태"
            retry={status.canRetry && !manualRefresh.isPending ? manualRefresh.mutate : undefined}
            retryLabel={status.retryLabel}
        />
    );
}

function LaundryPageBody({
    manualRefresh,
}: {
    manualRefresh: ReturnType<typeof useCampusManualRefresh>;
}) {
    const {platform} = useDashboardEnvironment();
    const isOnline = useOnlineStatus();
    const riskToggleId = useId();
    const riskIndicatorAvailable = platform.capabilities.laundryRiskIndicator;
    const [showRisk, setShowRisk] = useState(riskIndicatorAvailable);

    const laundry = useSuspenseLaundryQuery();
    const snapshot = laundry.data;
    const nowMs = laundry.dataUpdatedAt;
    const manualRefreshFailureIsCurrent =
        manualRefresh.isError && manualRefresh.submittedAt >= laundry.dataUpdatedAt;
    const recoveredFromManualRefresh =
        manualRefresh.isError &&
        manualRefresh.submittedAt > 0 &&
        laundry.dataUpdatedAt > manualRefresh.submittedAt;

    const collectorUnavailable = !snapshot.quality.collectorHealthy;
    const reliable =
        snapshot.quality.collectorHealthy &&
        snapshot.quality.collection === 'SUCCESS' &&
        laundrySituationDataIsReliable({
            hasData: snapshot.machines.length > 0,
            error: laundry.error,
            sourceFreshness: snapshot.quality.sourceFreshness,
            expectedRefreshIntervalSeconds: snapshot.quality.expectedRefreshIntervalSeconds,
            snapshotSavedAt: Date.parse(snapshot.asOf),
            nowMs,
        });

    const status = laundryPageState({
        snapshot,
        nowMs,
        isOffline: !isOnline || laundry.fetchStatus === 'paused',
        queryError: laundry.error,
        manualRefreshError: manualRefreshFailureIsCurrent ? manualRefresh.error : null,
        recovered:
            (recoveredFromManualRefresh ||
                (laundry.errorUpdatedAt > 0 && laundry.dataUpdatedAt > laundry.errorUpdatedAt)) &&
            !laundry.isError &&
            !laundry.isStale &&
            !manualRefreshFailureIsCurrent,
    });

    const dataStale = collectorUnavailable || isFailureKind(status.kind);
    const staleLabel = staleBanner(status);
    const statusTitle = collectorUnavailable ? COLLECTOR_UNAVAILABLE_TITLE : status.title;
    const statusMessage = collectorUnavailable ? COLLECTOR_UNAVAILABLE_MESSAGE : status.message;
    const summaries = capacityCards(snapshot.capacity, reliable);

    return (
        <div className="space-y-6">
            <LaundryStatusNotice
                manualRefresh={manualRefresh}
                message={statusMessage}
                status={status}
                title={statusTitle}
            />

            <nav aria-label="세부 섹션 이동" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {LAUNDRY_JUMPS.map(([label, anchor]) => (
                    <a
                        key={anchor}
                        className="min-h-11 rounded-md border border-border px-3 py-3 text-center text-base hover:bg-muted/50"
                        href={`#${anchor}`}
                    >
                        {label}
                    </a>
                ))}
            </nav>

            <section aria-labelledby="laundry-capacity-title">
                <div className="mb-3">
                    <h2 className="font-semibold" id="laundry-capacity-title">
                        지금 시작 가능
                    </h2>
                    <p className="text-xs text-muted-foreground">
                        마지막 확인{' '}
                        {relativeTimeLabel(snapshot.quality.lastCheckedAt ?? snapshot.asOf, nowMs)}
                    </p>
                    {staleLabel ? (
                        <p className="text-base leading-6 text-amber-700 dark:text-amber-300">
                            {staleLabel}
                        </p>
                    ) : null}
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                    {summaries.map((card) => (
                        <Card
                            className={cn(
                                'gap-3 py-5 shadow-none',
                                card.status === 'available' && 'justify-center',
                                capacityTone(card),
                            )}
                            key={card.access}
                        >
                            <CardHeader className="gap-1 px-5">
                                <CardDescription>{card.label}</CardDescription>
                                <CardTitle className="flex items-baseline gap-2 text-3xl tabular-nums">
                                    {card.count === null ? '—' : `${card.count}회`}
                                    {card.count === null ? null : (
                                        <span className="text-sm font-normal text-muted-foreground">
                                            지금 시작 가능
                                        </span>
                                    )}
                                </CardTitle>
                            </CardHeader>
                            {card.status !== 'available' ? (
                                <CardContent className="px-5 text-base leading-6 text-muted-foreground">
                                    {card.description}
                                </CardContent>
                            ) : null}
                        </Card>
                    ))}
                </div>
            </section>

            <Card className="gap-0 overflow-hidden py-0" id="laundry-tower-title">
                <CardHeader className="flex items-center justify-between gap-2 border-b px-4 py-3 sm:px-6 [.border-b]:pb-3">
                    <h2 className="flex items-center gap-2 leading-none font-semibold">
                        <WashingMachine className="size-4 text-primary" />
                        워시타워 상태
                    </h2>
                    <div
                        aria-label="워시타워 구역 및 경고 범례"
                        className="flex shrink-0 items-center gap-1"
                        data-laundry-zone-legend="true"
                    >
                        <LaundryZoneBadge zone="men" />
                        <LaundryZoneBadge zone="common" />
                        <LaundryZoneBadge zone="women" />
                        <LaundryWarningBadge />
                    </div>
                </CardHeader>
                {riskIndicatorAvailable ? (
                    <div className="flex items-center justify-end gap-3 border-b px-4 py-3 sm:px-6">
                        <Label htmlFor={riskToggleId}>최근 7일 에러 위험 표시</Label>
                        <Switch
                            aria-label="최근 7일 에러 위험 표시"
                            checked={showRisk}
                            id={riskToggleId}
                            onCheckedChange={setShowRisk}
                        />
                    </div>
                ) : null}
                <CardContent className="px-4 pt-0 pb-3 sm:px-6">
                    {staleLabel ? (
                        <p className="mb-2 text-base leading-6 text-amber-700 dark:text-amber-300">
                            {staleLabel}
                        </p>
                    ) : null}
                    {snapshot.machines.length > 0 ? (
                        <WashTowerGrid
                            machines={snapshot.machines}
                            nowMs={nowMs}
                            showRiskIndicators={showRisk}
                            dataStale={dataStale}
                            dataStaleLabel={status.lastKnownLabel}
                        />
                    ) : (
                        <p className="py-5 text-center text-base leading-6 text-muted-foreground">
                            표시할 워시타워가 없습니다.
                        </p>
                    )}
                </CardContent>
            </Card>

            <section aria-label="기기별 상세 상태" id="laundry-detail-title">
                <LaundryMachineList
                    machines={snapshot.machines}
                    nowMs={nowMs}
                    showRiskWarnings={showRisk}
                    dataStale={dataStale}
                    staleLabel={status.lastKnownLabel}
                />
            </section>

            <section aria-label="내 세탁 알림" id="laundry-watch-title">
                {status.allowWatchCreation ? (
                    <PersonalLaundrySection machines={snapshot.machines} />
                ) : (
                    <PersonalLaundrySection canCreateWatch={false} machines={snapshot.machines} />
                )}
                {status.kind === 'recovered' ? (
                    <p className="mt-2 text-base leading-6 text-emerald-700 dark:text-emerald-300">
                        이전 오류에서 복구되어 실시간 조회가 재개됩니다.
                    </p>
                ) : null}
            </section>
        </div>
    );
}

export interface LaundryDataRegionProps {
    manualRefresh: ReturnType<typeof useCampusManualRefresh>;
}

/** Query and failure boundary that can be mounted independently from sibling features. */
export function LaundryDataRegion({manualRefresh}: LaundryDataRegionProps) {
    return (
        <LaundryFeatureBoundary>
            <LaundryPageBody manualRefresh={manualRefresh} />
        </LaundryFeatureBoundary>
    );
}

export function LaundryFeature() {
    const manualRefresh = useCampusManualRefresh('laundry');
    return <LaundryDataRegion manualRefresh={manualRefresh} />;
}

export function LaundryPage() {
    const manualRefresh = useCampusManualRefresh('laundry');
    const isOnline = useOnlineStatus();
    const refreshing = manualRefresh.isPending;

    return (
        <div className="space-y-6">
            <PageHeader
                title="세탁실"
                actions={
                    <Button
                        disabled={refreshing || !isOnline}
                        variant="outline"
                        onClick={() => manualRefresh.mutate()}
                    >
                        <RefreshCw className={cn(refreshing && 'animate-spin')} />
                        {!isOnline ? '오프라인' : refreshing ? '새로고침 중' : '새로고침'}
                    </Button>
                }
            />
            <LaundryDataRegion manualRefresh={manualRefresh} />
        </div>
    );
}
