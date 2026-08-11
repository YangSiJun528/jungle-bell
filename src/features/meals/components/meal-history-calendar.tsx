import {useMemo, useState} from 'react';
import {ChevronLeft, ChevronRight} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {cn} from '@/lib/utils';
import {
    calendarMonthCells,
    type CalendarMonthCell,
    monthLabel,
    shiftMonth,
} from '../lib/meal-view';

const WEEKDAYS = ['\uC77C', '\uC6D4', '\uD654', '\uC218', '\uBAA9', '\uAE08', '\uD1A0'] as const;

export function MealHistoryDayButton({
    cell,
    hasMeal,
    onSelect,
    selected,
}: {
    cell: CalendarMonthCell;
    hasMeal: boolean;
    onSelect: (date: string) => void;
    selected: boolean;
}) {
    return (
        <button
            aria-label={`${cell.date}${hasMeal ? ' \uAE09\uC2DD \uAE30\uB85D \uC788\uC74C' : ' \uAE09\uC2DD \uAE30\uB85D \uC5C6\uC74C'}`}
            aria-pressed={selected}
            className={cn(
                'aspect-square rounded-md text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                hasMeal && 'font-semibold text-primary hover:bg-accent',
                selected && 'bg-primary text-primary-foreground hover:bg-primary',
                !hasMeal && 'cursor-default text-muted-foreground/45',
            )}
            data-has-meal={hasMeal}
            disabled={!hasMeal}
            type="button"
            onClick={() => onSelect(cell.date)}
        >
            {cell.day}
        </button>
    );
}

export function MealHistoryCalendar({
    availableDates,
    onSelect,
    selectedDate,
}: {
    availableDates: ReadonlySet<string>;
    onSelect: (date: string) => void;
    selectedDate: string;
}) {
    const [visibleMonth, setVisibleMonth] = useState(() => selectedDate.slice(0, 7));

    const cells = useMemo(() => calendarMonthCells(visibleMonth), [visibleMonth]);
    return (
        <div aria-label={`${monthLabel(visibleMonth)} \uAE09\uC2DD \uAE30\uB85D \uB2EC\uB825`} role="group">
            <div className="mb-3 flex items-center justify-between gap-2">
                <Button
                    aria-label="이전 달"
                    size="icon-sm"
                    variant="ghost"
                    onClick={() => setVisibleMonth((month) => shiftMonth(month, -1))}
                >
                    <ChevronLeft/>
                </Button>
                <strong className="text-sm">{monthLabel(visibleMonth)}</strong>
                <Button
                    aria-label="다음 달"
                    size="icon-sm"
                    variant="ghost"
                    onClick={() => setVisibleMonth((month) => shiftMonth(month, 1))}
                >
                    <ChevronRight/>
                </Button>
            </div>
            <div className="grid grid-cols-7 text-center text-xs text-muted-foreground" aria-hidden="true">
                {WEEKDAYS.map((day) => <span className="py-2" key={day}>{day}</span>)}
            </div>
            <div className="grid grid-cols-7 gap-1">
                {cells.map((cell, index) => {
                    if (!cell) return <span aria-hidden="true" key={`empty-${index}`} className="aspect-square"/>;
                    const hasMeal = availableDates.has(cell.date);
                    const selected = selectedDate === cell.date;
                    return (
                        <MealHistoryDayButton
                            cell={cell}
                            hasMeal={hasMeal}
                            key={cell.date}
                            selected={selected}
                            onSelect={onSelect}
                        />
                    );
                })}
            </div>
        </div>
    );
}
