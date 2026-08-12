import {ChevronDown, Flag} from 'lucide-react';
import {useState} from 'react';
import {
    Card,
    CardContent,
} from '@/components/ui/card';
import {
    Collapsible,
    CollapsibleContent,
    CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {Progress} from '@/components/ui/progress';
import type {DdayPeriod, DdayProgress} from '@/features/home/lib/dday-progress';
import type {HomeDdayView} from '@/features/home/lib/home-dday';
import {cn} from '@/lib/utils';

const DAYS = Array.from({length: 31}, (_, index) => index + 1);
const LABELED_DAYS = new Set([1, 10, 20, 31]);

function compactDate(value: string): string {
    return value.split('-').map(Number).join('.');
}

function periodLabel(period: DdayPeriod): string {
    return `${compactDate(period.startDate)} – ${compactDate(period.endDate)}`;
}

function progressLabel(progress: DdayProgress): string {
    const current = progress.current ? ', 오늘 진행 중' : '';
    return `코스 진행률 ${progress.percent}%, 완료 ${progress.elapsed}일${current}, 남음 ${progress.remaining}일`;
}

function DdayMatrix({progress}: {progress: DdayProgress}) {
    return (
        <div
            className="overflow-x-auto overscroll-x-contain"
            role="img"
            aria-label={progressLabel(progress)}
        >
            <div
                className="grid min-w-[20rem] grid-cols-[2.5rem_minmax(0,1fr)] gap-x-2 gap-y-1"
                aria-hidden="true"
            >
                <span className="self-end text-center text-[10px] font-semibold text-muted-foreground">월</span>
                <span className="grid grid-cols-[repeat(31,minmax(0,1fr))] gap-0.5">
                    {DAYS.map((day) => (
                        <span
                            className="flex min-w-0 justify-center text-[9px] font-medium tabular-nums text-muted-foreground"
                            data-dday-day-axis="true"
                            key={day}
                        >
                            {LABELED_DAYS.has(day) ? day : ''}
                        </span>
                    ))}
                </span>

                {progress.rows.map((row) => (
                    <div className="contents" key={row.key}>
                        <span className="self-center text-right text-xs font-medium tabular-nums text-muted-foreground" title={row.label}>
                            {row.shortLabel}
                        </span>
                        <span className="grid grid-cols-[repeat(31,minmax(0,1fr))] gap-0.5">
                            {row.cells.map((cell, dayIndex) => (
                                <span
                                    className={cn(
                                        'aspect-square min-w-0 rounded-[2px]',
                                        cell === null && 'bg-transparent',
                                        cell?.state === 'elapsed' && 'bg-primary',
                                        cell?.state === 'current' && 'bg-primary/15 ring-1 ring-inset ring-primary',
                                        cell?.state === 'remaining' && 'bg-transparent ring-1 ring-inset ring-border',
                                    )}
                                    data-dday-cell="true"
                                    data-dday-state={cell?.state ?? 'outside'}
                                    key={`${row.key}-${dayIndex + 1}`}
                                    title={cell
                                        ? (cell.state === 'current' ? `${cell.label} · 오늘` : cell.label)
                                        : undefined}
                                />
                            ))}
                        </span>
                    </div>
                ))}
            </div>
        </div>
    );
}

export interface HomeDdayCardProps {
    view: HomeDdayView;
    defaultOpen?: boolean;
}

export function HomeDdayCard({view, defaultOpen = false}: HomeDdayCardProps) {
    const [open, setOpen] = useState(defaultOpen);
    const {period, progress} = view;
    const canExpand = progress !== null && period !== null;

    return (
        <Collapsible asChild open={canExpand && open} onOpenChange={setOpen}>
            <Card className="w-full gap-0 overflow-hidden border-primary/20 py-0" data-home-dday-card="true">
                <CollapsibleTrigger
                    className="group/dday flex min-h-20 w-full items-center gap-3 px-5 py-4 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:cursor-default disabled:hover:bg-transparent sm:px-6"
                    disabled={!canExpand}
                    aria-controls="home-dday-calendar"
                    aria-label={canExpand
                        ? `${view.text}, 과정 달력 ${open ? '접기' : '펼치기'}`
                        : view.text}
                >
                    <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
                        <Flag aria-hidden="true" className="size-5"/>
                    </span>
                    <span className="min-w-0 flex-1">
                        <span className="block text-xs font-semibold text-primary">D-Day</span>
                        <strong className="block truncate text-base">{view.text}</strong>
                    </span>
                    {progress ? (
                        <strong className="shrink-0 text-sm tabular-nums text-primary">{progress.percent}%</strong>
                    ) : null}
                    {canExpand ? (
                        <ChevronDown
                            aria-hidden="true"
                            className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/dday:rotate-180 motion-reduce:transition-none"
                        />
                    ) : null}
                </CollapsibleTrigger>

                <CardContent className="px-5 pb-4 sm:px-6">
                    {progress && period ? (
                        <div className="space-y-2">
                            <Progress
                                value={progress.percent}
                                aria-label={progressLabel(progress)}
                            />
                            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                                <span>완료 <strong className="text-foreground">{progress.elapsed}</strong>일</span>
                                <span>남음 <strong className="text-foreground">{progress.remaining}</strong>일</span>
                                <time className="ml-auto whitespace-nowrap tabular-nums">{periodLabel(period)}</time>
                            </div>
                        </div>
                    ) : (
                        <p className="text-sm text-muted-foreground">
                            세부 과정 기간이 확인되면 진행률과 전체 달력을 표시합니다.
                        </p>
                    )}
                </CardContent>

                {canExpand && progress ? (
                    <CollapsibleContent id="home-dday-calendar">
                        <div className="border-t px-5 py-4 sm:px-6">
                            <DdayMatrix progress={progress}/>
                        </div>
                    </CollapsibleContent>
                ) : null}
            </Card>
        </Collapsible>
    );
}
