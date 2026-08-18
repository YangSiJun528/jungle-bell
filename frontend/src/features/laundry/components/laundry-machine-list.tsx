import {useId} from 'react';
import {
    CircleAlert,
    CircleCheck,
    CircleDashed,
    Clock3,
    TriangleAlert,
} from 'lucide-react';
import {Card, CardContent, CardHeader} from '@/components/ui/card';
import {Progress} from '@/components/ui/progress';
import {TooltipProvider} from '@/components/ui/tooltip';
import type {DashboardLaundryMachine} from '@/domain/laundry/capacity';
import {cn} from '@/lib/utils';
import {
    laundryMachineDetail,
    type LaundryApplianceDetailView,
    type LaundryApplianceTone,
} from '../lib/laundry-machine-detail';
import {sortWashTowers} from '../lib/wash-tower';
import {
    LAUNDRY_WARNING_PROGRESS_CLASS_NAME,
    LAUNDRY_WARNING_TEXT_CLASS_NAME,
} from '../lib/laundry-warning';
import {LaundryStatusHint} from './laundry-status-hint';
import {LaundryZoneBadge} from './laundry-zone-badge';

export interface LaundryMachineListProps {
    machines: readonly DashboardLaundryMachine[];
    nowMs?: number;
    showRiskWarnings?: boolean;
}

const clockFormatter = new Intl.DateTimeFormat('ko-KR', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Asia/Seoul',
});

const statusClasses: Readonly<Record<LaundryApplianceTone, string>> = {
    active: 'text-primary',
    available: 'text-primary',
    confirming: 'text-primary',
    error: 'text-destructive',
    neutral: 'text-muted-foreground',
    warning: LAUNDRY_WARNING_TEXT_CLASS_NAME,
};

function clockLabel(value: string): string {
    return clockFormatter.format(new Date(value));
}

function StatusIcon({tone}: {tone: LaundryApplianceTone}) {
    const className = 'size-4 shrink-0';
    if (tone === 'available') return <CircleCheck className={className}/>;
    if (tone === 'error') return <CircleAlert className={className}/>;
    if (tone === 'warning') return <TriangleAlert className={className}/>;
    if (tone === 'confirming') return <Clock3 className={className}/>;
    if (tone === 'active') return <Clock3 className={className}/>;
    return <CircleDashed className={className}/>;
}

function RecentRiskNotice({view}: {view: LaundryApplianceDetailView}) {
    const notice = view.riskNotice;
    if (!notice || view.riskLevel === undefined || view.riskLevel === 'safe') return null;

    return (
        <div
            className={cn(
                'rounded-md border px-3 py-2 text-xs leading-5',
                view.riskLevel === 'caution'
                    ? 'border-destructive/40 bg-destructive/5 text-destructive'
                    : 'border-orange-400/60 bg-orange-50 text-orange-900 dark:border-orange-500/60 dark:bg-orange-950/40 dark:text-orange-200',
            )}
            data-laundry-risk-notice="true"
            data-risk-level={view.riskLevel}
        >
            <strong className="font-semibold">최근 7일 · {notice.label}</strong>
            <p className="tabular-nums">{notice.summary}</p>
            <p>{notice.description}</p>
        </div>
    );
}

function ApplianceDetail({
    machineTitle,
    showRiskWarning,
    titleId,
    view,
}: {
    machineTitle: string;
    showRiskWarning: boolean;
    titleId: string;
    view: LaundryApplianceDetailView;
}) {
    const progressText = view.progress === null
        ? null
        : view.tone === 'error'
            ? '오류로 진행률을 확인할 수 없음'
            : [
                `${view.progress}% 진행`,
                view.remainingLabel,
                view.totalLabel,
            ].filter(Boolean).join(', ');
    const hasStatusHint = view.helpText !== null || view.errorCode !== null;

    return (
        <section
            className="flex h-full flex-col gap-3 border-b p-4 last:border-b-0"
            aria-labelledby={titleId}
            data-kind={view.kind}
        >
            <div className="flex min-w-0 items-center justify-between gap-3">
                <h4 className="text-sm font-medium" id={titleId}>{view.label}</h4>
                <div className="flex min-w-0 items-center gap-0.5">
                    <span
                        className={cn(
                            'inline-flex min-w-0 items-center gap-1.5 text-sm font-medium',
                            statusClasses[view.tone],
                        )}
                        data-state={view.tone}
                    >
                        <StatusIcon tone={view.tone}/>
                        <span className="truncate">{view.statusLabel}</span>
                    </span>
                    {hasStatusHint ? (
                        <LaundryStatusHint label={`${machineTitle} ${view.label} 상세 안내`}>
                            {view.helpText ? <p>{view.helpText}</p> : null}
                            {view.errorCode ? (
                                <p>오류 코드 <code className="break-all font-mono">{view.errorCode}</code></p>
                            ) : null}
                        </LaundryStatusHint>
                    ) : null}
                </div>
            </div>

            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <strong className="text-lg tabular-nums">{view.remainingLabel}</strong>
                {view.totalLabel ? (
                    <span className="text-xs tabular-nums text-muted-foreground">{view.totalLabel}</span>
                ) : null}
            </div>

            {view.progress === null ? null : (
                <div>
                    <Progress
                        aria-label={`${machineTitle} ${view.kind === 'washer' ? '세탁' : '건조'} 진행률`}
                        aria-valuetext={progressText ?? undefined}
                        className={cn(view.tone === 'warning'
                            && LAUNDRY_WARNING_PROGRESS_CLASS_NAME)}
                        value={view.progress}
                    />
                </div>
            )}

            {view.startedAt || view.estimatedFinishAt ? (
                <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs tabular-nums text-muted-foreground">
                    {view.startedAt ? (
                        <time dateTime={view.startedAt}>{clockLabel(view.startedAt)} 시작</time>
                    ) : null}
                    {view.estimatedFinishAt ? (
                        <time dateTime={view.estimatedFinishAt}>
                            {clockLabel(view.estimatedFinishAt)} 종료
                        </time>
                    ) : null}
                </p>
            ) : null}

            {showRiskWarning ? <RecentRiskNotice view={view}/> : null}

        </section>
    );
}

export function LaundryMachineList({
    machines,
    nowMs = Date.now(),
    showRiskWarnings = false,
}: LaundryMachineListProps) {
    const titleId = useId();
    const views = sortWashTowers(machines).map((machine) => laundryMachineDetail(machine, nowMs));
    if (views.length === 0) return null;

    return (
        <section className="space-y-3" aria-labelledby={titleId} data-laundry-detail-list="true">
            <h2 className="font-semibold" id={titleId}>기기별 상세 상태</h2>
            <TooltipProvider delayDuration={200}>
                <div className="grid auto-rows-fr gap-3 md:grid-cols-2 lg:grid-cols-3">
                    {views.map((machine, machineIndex) => (
                        <Card className="h-full gap-0 overflow-hidden py-0 shadow-none" data-laundry-machine-card="true" key={machine.id}>
                            <CardHeader className="flex flex-row items-center justify-between gap-3 border-b px-4 py-3 [.border-b]:pb-3">
                                <h3 className="text-base font-semibold leading-none">{machine.title}</h3>
                                <LaundryZoneBadge zone={machine.zone}/>
                            </CardHeader>
                            <CardContent className="grid flex-1 grid-rows-2 p-0">
                                <ApplianceDetail
                                    machineTitle={machine.title}
                                    showRiskWarning={showRiskWarnings}
                                    titleId={`${titleId}-${machineIndex}-dryer`}
                                    view={machine.dryer}
                                />
                                <ApplianceDetail
                                    machineTitle={machine.title}
                                    showRiskWarning={showRiskWarnings}
                                    titleId={`${titleId}-${machineIndex}-washer`}
                                    view={machine.washer}
                                />
                            </CardContent>
                        </Card>
                    ))}
                </div>
            </TooltipProvider>
        </section>
    );
}
