import {CircleAlert, RefreshCw, WashingMachine} from 'lucide-react';
import {useId, useState} from 'react';

import {useDashboardEnvironment} from '@/app/dashboard-context';
import {useCampusManualRefresh, useSuspenseLaundryQuery} from '@/app/use-dashboard-queries';
import {laundryZonePresentation} from '@/components/dashboard/laundry-zone-presentation';
import {PageHeader} from '@/components/dashboard/page-header';
import {Alert, AlertDescription, AlertTitle} from '@/components/ui/alert';
import {Button} from '@/components/ui/button';
import {Card, CardContent, CardDescription, CardHeader, CardTitle} from '@/components/ui/card';
import {Label} from '@/components/ui/label';
import {Switch} from '@/components/ui/switch';
import {laundrySituationDataIsReliable} from '@/domain/laundry/freshness';
import {relativeTimeLabel} from '@/lib/format';
import {cn} from '@/lib/utils';

import {LaundryMachineList} from '../components/laundry-machine-list';
import {LaundryWarningBadge} from '../components/laundry-warning-badge';
import {LaundryZoneBadge} from '../components/laundry-zone-badge';
import {PersonalLaundrySection} from '../components/personal-laundry-section';
import {WashTowerGrid} from '../components/wash-tower-grid';
import {capacityCards, type CapacityCardView} from './laundry-page-view';

function capacityTone(card: CapacityCardView): string {
    if (card.status === 'checking') return 'border-border bg-muted/30';
    return laundryZonePresentation(card.access).surfaceClassName;
}

export function LaundryPage() {
    const {platform} = useDashboardEnvironment();
    const laundry = useSuspenseLaundryQuery();
    const manualRefresh = useCampusManualRefresh('laundry');
    const riskToggleId = useId();
    const riskIndicatorAvailable = platform.capabilities.laundryRiskIndicator;
    const [showRisk, setShowRisk] = useState(riskIndicatorAvailable);

    const snapshot = laundry.data;
    const nowMs = laundry.dataUpdatedAt;
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
    const summaries = capacityCards(snapshot.capacity, reliable);
    const refreshFailed = laundry.isError || manualRefresh.isError;
    const refreshing = laundry.isFetching || manualRefresh.isPending;
    const collectorUnavailable = !snapshot.quality.collectorHealthy;

    return (
        <div className="space-y-6">
            <PageHeader
                title="세탁실"
                actions={
                    <Button
                        disabled={refreshing}
                        variant="outline"
                        onClick={() => manualRefresh.mutate()}
                    >
                        <RefreshCw className={cn(refreshing && 'animate-spin')} />
                        {refreshing ? '새로고침 중' : '새로고침'}
                    </Button>
                }
            />

            {collectorUnavailable ? (
                <Alert variant="destructive">
                    <CircleAlert />
                    <AlertTitle>세탁실 수집 서버에 문제가 있습니다.</AlertTitle>
                    <AlertDescription>
                        실시간 상태를 확인할 수 없어 마지막 정상 데이터를 표시합니다.
                    </AlertDescription>
                </Alert>
            ) : refreshFailed ? (
                <Alert variant="destructive">
                    <CircleAlert />
                    <AlertTitle>최신 기기 상태를 불러오지 못했습니다.</AlertTitle>
                    <AlertDescription>마지막으로 확인한 기기 상태를 표시합니다.</AlertDescription>
                </Alert>
            ) : null}

            <section aria-labelledby="laundry-capacity-title">
                <div className="mb-3">
                    <h2 className="font-semibold" id="laundry-capacity-title">
                        지금 시작 가능
                    </h2>
                    <p className="text-xs text-muted-foreground">
                        마지막 확인{' '}
                        {relativeTimeLabel(snapshot.quality.lastCheckedAt ?? snapshot.asOf)}
                    </p>
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
                                        <span className="text-xs font-normal text-muted-foreground">
                                            지금 시작 가능
                                        </span>
                                    )}
                                </CardTitle>
                            </CardHeader>
                            {card.status !== 'available' ? (
                                <CardContent className="px-5 text-xs leading-5 text-muted-foreground">
                                    {card.description}
                                </CardContent>
                            ) : null}
                        </Card>
                    ))}
                </div>
            </section>

            <Card className="gap-0 overflow-hidden py-0">
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
                    {snapshot.machines.length > 0 ? (
                        <WashTowerGrid
                            machines={snapshot.machines}
                            nowMs={nowMs}
                            showRiskIndicators={showRisk}
                        />
                    ) : (
                        <p className="py-5 text-center text-sm text-muted-foreground">
                            표시할 워시타워가 없습니다.
                        </p>
                    )}
                </CardContent>
            </Card>

            <LaundryMachineList
                machines={snapshot.machines}
                nowMs={nowMs}
                showRiskWarnings={showRisk}
            />

            <PersonalLaundrySection machines={snapshot.machines} />
        </div>
    );
}
