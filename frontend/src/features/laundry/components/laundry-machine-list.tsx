import {CircleAlert, CircleCheck, CircleDashed, Clock3, TriangleAlert} from 'lucide-react';
import {useId} from 'react';

import {Card, CardContent, CardHeader} from '@/components/ui/card';
import {Progress} from '@/components/ui/progress';
import {TooltipProvider} from '@/components/ui/tooltip';
import type {DashboardLaundryMachine} from '@/domain/laundry/capacity';
import {cn} from '@/lib/utils';

import {
    laundryMachineDetail,
    type LaundryApplianceDetailView,
    type LaundryApplianceTone,
    type LaundryMachineDetailView,
} from '../lib/laundry-machine-detail';
import {
    LAUNDRY_WARNING_PROGRESS_CLASS_NAME,
    LAUNDRY_WARNING_TEXT_CLASS_NAME,
} from '../lib/laundry-warning';
import {sortWashTowers} from '../lib/wash-tower';
import {LaundryStatusHint} from './laundry-status-hint';
import {LaundryZoneBadge} from './laundry-zone-badge';

export interface LaundryMachineListProps {
    machines: readonly DashboardLaundryMachine[];
    nowMs: number;
    showRiskWarnings?: boolean;
    dataStale?: boolean;
    staleLabel?: string | null;
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
    if (tone === 'available') return <CircleCheck aria-hidden="true" className={className} />;
    if (tone === 'error') return <CircleAlert aria-hidden="true" className={className} />;
    if (tone === 'warning') return <TriangleAlert aria-hidden="true" className={className} />;
    if (tone === 'confirming') return <Clock3 aria-hidden="true" className={className} />;
    if (tone === 'active') return <Clock3 aria-hidden="true" className={className} />;
    return <CircleDashed aria-hidden="true" className={className} />;
}

function RecentRiskNotice({view}: {view: LaundryApplianceDetailView}) {
    const notice = view.riskNotice;
    if (!notice || view.riskLevel === undefined || view.riskLevel === 'safe') return null;

    return (
        <div
            className={cn(
                'rounded-md border px-3 py-2 text-base leading-6',
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

function applianceProgressText(view: LaundryApplianceDetailView): string | null {
    if (view.progress === null) return null;
    if (view.tone === 'error') return '오류로 진행률을 확인할 수 없음';
    return [`${view.progress}% 진행`, view.remainingLabel, view.totalLabel]
        .filter(Boolean)
        .join(', ');
}

function ApplianceStatus({
    machineTitle,
    titleId,
    view,
}: {
    machineTitle: string;
    titleId: string;
    view: LaundryApplianceDetailView;
}) {
    const hasStatusHint = view.helpText !== null || view.errorCode !== null;

    return (
        <div className="flex min-w-0 items-center justify-between gap-3">
            <h4 className="text-base leading-6 font-medium" id={titleId}>
                {view.label}
            </h4>
            <div className="flex min-w-0 items-center gap-0.5">
                <span
                    className={cn(
                        'inline-flex min-w-0 items-center gap-1.5 text-base leading-6 font-medium',
                        statusClasses[view.tone],
                    )}
                    data-laundry-appliance-status="true"
                    data-state={view.tone}
                >
                    <StatusIcon tone={view.tone} />
                    <span className="break-words">{view.statusLabel}</span>
                </span>
                {hasStatusHint ? (
                    <LaundryStatusHint label={`${machineTitle} ${view.label} 상세 안내`}>
                        {view.helpText ? <p>{view.helpText}</p> : null}
                        {view.errorCode ? (
                            <p>
                                오류 코드{' '}
                                <code className="font-mono break-all">{view.errorCode}</code>
                            </p>
                        ) : null}
                    </LaundryStatusHint>
                ) : null}
            </div>
        </div>
    );
}

function ApplianceProgress({
    machineTitle,
    view,
}: {
    machineTitle: string;
    view: LaundryApplianceDetailView;
}) {
    if (view.progress === null) return null;

    return (
        <Progress
            aria-label={`${machineTitle} ${view.kind === 'washer' ? '세탁' : '건조'} 진행률`}
            aria-valuetext={applianceProgressText(view) ?? undefined}
            className={cn(view.tone === 'warning' && LAUNDRY_WARNING_PROGRESS_CLASS_NAME)}
            value={view.progress}
        />
    );
}

function ApplianceTiming({view}: {view: LaundryApplianceDetailView}) {
    if (!view.startedAt && !view.estimatedFinishAt) return null;

    return (
        <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground tabular-nums">
            {view.startedAt ? (
                <time dateTime={view.startedAt}>{clockLabel(view.startedAt)} 시작</time>
            ) : null}
            {view.estimatedFinishAt ? (
                <time dateTime={view.estimatedFinishAt}>
                    {clockLabel(view.estimatedFinishAt)} 종료
                </time>
            ) : null}
        </p>
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
    return (
        <section
            className="flex h-full min-w-0 flex-col gap-3 border-b p-4 last:border-b-0"
            aria-labelledby={titleId}
            data-kind={view.kind}
        >
            <ApplianceStatus machineTitle={machineTitle} titleId={titleId} view={view} />
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <strong className="text-lg tabular-nums">{view.remainingLabel}</strong>
                {view.totalLabel ? (
                    <span className="text-xs text-muted-foreground tabular-nums">
                        {view.totalLabel}
                    </span>
                ) : null}
            </div>
            <ApplianceProgress machineTitle={machineTitle} view={view} />
            <ApplianceTiming view={view} />
            {showRiskWarning ? <RecentRiskNotice view={view} /> : null}
        </section>
    );
}

function LaundryMachineCard({
    dataStale,
    index,
    machine,
    showRiskWarnings,
    titleId,
}: {
    dataStale: boolean;
    index: number;
    machine: LaundryMachineDetailView;
    showRiskWarnings: boolean;
    titleId: string;
}) {
    return (
        <Card
            className="h-full min-w-0 gap-0 overflow-hidden py-0 shadow-none"
            data-data-state={dataStale ? 'stale' : 'current'}
            data-laundry-machine-card="true"
        >
            <CardHeader className="flex min-w-0 flex-row items-center justify-between gap-3 border-b px-4 py-3 [.border-b]:pb-3">
                <h3 className="text-base leading-none font-semibold">{machine.title}</h3>
                <div className="flex shrink-0 items-center gap-2">
                    {dataStale ? (
                        <span className="text-base leading-6 text-amber-700 dark:text-amber-300">
                            실시간 아님
                        </span>
                    ) : null}
                    <LaundryZoneBadge zone={machine.zone} />
                </div>
            </CardHeader>
            <CardContent className="flex flex-1 flex-col p-0">
                <div className="grid flex-1 grid-rows-2">
                    <ApplianceDetail
                        machineTitle={machine.title}
                        showRiskWarning={showRiskWarnings}
                        titleId={`${titleId}-${index}-dryer`}
                        view={machine.dryer}
                    />
                    <ApplianceDetail
                        machineTitle={machine.title}
                        showRiskWarning={showRiskWarnings}
                        titleId={`${titleId}-${index}-washer`}
                        view={machine.washer}
                    />
                </div>
            </CardContent>
        </Card>
    );
}

export function LaundryMachineList({
    machines,
    nowMs,
    showRiskWarnings = false,
    dataStale = false,
    staleLabel,
}: LaundryMachineListProps) {
    const titleId = useId();
    const views = sortWashTowers(machines).map((machine) => laundryMachineDetail(machine, nowMs));
    if (views.length === 0) return null;

    return (
        <section className="space-y-3" aria-labelledby={titleId} data-laundry-detail-list="true">
            <h2 className="font-semibold" id={titleId}>
                기기별 상세 상태
            </h2>
            {dataStale ? (
                <p className="text-base leading-6 text-amber-700 dark:text-amber-300">
                    실시간 정보가 아닙니다 · 마지막 정상 시각 {staleLabel ?? '확인 기록 없음'}
                </p>
            ) : null}
            <TooltipProvider delayDuration={200}>
                <div className="grid items-stretch gap-3 md:grid-cols-2 lg:grid-cols-3">
                    {views.map((machine, machineIndex) => (
                        <LaundryMachineCard
                            dataStale={dataStale}
                            index={machineIndex}
                            key={machine.id}
                            machine={machine}
                            showRiskWarnings={showRiskWarnings}
                            titleId={titleId}
                        />
                    ))}
                </div>
            </TooltipProvider>
        </section>
    );
}
