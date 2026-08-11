import {
    CircleAlert,
    RefreshCw,
    WashingMachine,
} from 'lucide-react';
import {useCampusDataIssue, useDashboardEnvironment} from '@/app/dashboard-context';
import {useCampusManualRefresh, useLaundryQuery} from '@/app/use-dashboard-queries';
import {ErrorState, LoadingState} from '@/components/dashboard/async-state';
import {PageHeader} from '@/components/dashboard/page-header';
import {Alert, AlertDescription, AlertTitle} from '@/components/ui/alert';
import {Button} from '@/components/ui/button';
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from '@/components/ui/card';
import type {PersonalSurface} from '@/api/personal-api';
import {laundrySituationDataIsReliable} from '@/domain/laundry/freshness';
import {relativeTimeLabel} from '@/lib/format';
import {cn} from '@/lib/utils';
import {LaundryMachineList} from '../components/laundry-machine-list';
import {LaundryZoneBadge} from '../components/laundry-zone-badge';
import {PersonalLaundrySection} from '../components/personal-laundry-section';
import {WashTowerGrid} from '../components/wash-tower-grid';
import {capacityCards, type CapacityCardView} from './laundry-page-view';

const personalSurface = (kind: string): PersonalSurface | null =>
    kind === 'desktop' || kind === 'companion' ? kind : null;

function capacityTone(card: CapacityCardView): string {
    if (card.status === 'checking') return 'border-border bg-muted/30';
    return card.access === 'men'
        ? 'border-blue-800/25 bg-blue-950/[0.06] text-blue-950 dark:border-blue-300/20 dark:bg-blue-200/[0.08] dark:text-blue-100'
        : 'border-rose-800/25 bg-rose-950/[0.06] text-rose-950 dark:border-rose-300/20 dark:bg-rose-200/[0.08] dark:text-rose-100';
}

export function LaundryPage() {
    const {surface} = useDashboardEnvironment();
    const laundry = useLaundryQuery();
    const manualRefresh = useCampusManualRefresh('laundry');
    const campusIssue = useCampusDataIssue('laundry');
    const personal = personalSurface(surface.kind);

    const snapshot = laundry.data;
    const reliable = snapshot
        ? snapshot.quality.collection === 'SUCCESS' && laundrySituationDataIsReliable({
            hasData: snapshot.machines.length > 0,
            error: laundry.error,
            sourceFreshness: snapshot.quality.sourceFreshness,
            snapshotSavedAt: Date.parse(snapshot.asOf),
            nowMs: Date.now(),
        })
        : false;
    const summaries = capacityCards(snapshot?.capacity ?? null, reliable);
    const refreshFailed = laundry.isError || manualRefresh.isError || campusIssue !== null;
    const refreshing = laundry.isFetching || manualRefresh.isPending;

    return (
        <div className="space-y-6">
            <PageHeader
                title="세탁실"
                actions={(
                    <Button
                        disabled={refreshing}
                        variant="outline"
                        onClick={() => manualRefresh.mutate()}
                    >
                        <RefreshCw className={cn(refreshing && 'animate-spin')}/>
                        새로고침
                    </Button>
                )}
            />

            {laundry.isPending && !snapshot ? (
                <LoadingState label="세탁실 기기 상태를 확인하고 있습니다."/>
            ) : laundry.isError && !snapshot ? (
                <ErrorState
                    description="잠시 후 다시 시도해 주세요."
                    retry={() => manualRefresh.mutate()}
                />
            ) : snapshot ? (
                <>
                    {refreshFailed ? (
                        <Alert variant="destructive">
                            <CircleAlert/>
                            <AlertTitle>최신 상태로 갱신하지 못했습니다.</AlertTitle>
                            <AlertDescription>마지막으로 확인한 기기 상태를 표시합니다.</AlertDescription>
                        </Alert>
                    ) : null}

                    <section aria-labelledby="laundry-capacity-title">
                        <div className="mb-3">
                            <h2 className="font-semibold" id="laundry-capacity-title">지금 시작 가능</h2>
                            <p className="text-xs text-muted-foreground">
                                마지막 확인 {relativeTimeLabel(snapshot.quality.lastCheckedAt ?? snapshot.asOf)}
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
                        <CardHeader className="flex items-center justify-between gap-2 border-b px-4 py-3 [.border-b]:pb-3 sm:px-6">
                            <h2 className="flex items-center gap-2 font-semibold leading-none">
                                <WashingMachine className="size-4 text-primary"/>
                                워시타워 상태
                            </h2>
                            <div
                                aria-label="워시타워 구역 범례"
                                className="flex shrink-0 items-center gap-1"
                                data-laundry-zone-legend="true"
                            >
                                <LaundryZoneBadge zone="men"/>
                                <LaundryZoneBadge zone="common"/>
                                <LaundryZoneBadge zone="women"/>
                            </div>
                        </CardHeader>
                        <CardContent className="px-4 pb-3 pt-0 sm:px-6">
                            {snapshot.machines.length > 0 ? (
                                <WashTowerGrid machines={snapshot.machines}/>
                            ) : (
                                <p className="py-5 text-center text-sm text-muted-foreground">
                                    표시할 워시타워가 없습니다.
                                </p>
                            )}
                        </CardContent>
                    </Card>

                    <LaundryMachineList machines={snapshot.machines}/>
                </>
            ) : null}

            {personal === null ? null : (
                <PersonalLaundrySection
                    surface={personal}
                    machines={snapshot?.machines ?? []}
                />
            )}
        </div>
    );
}
