import {ko} from 'react-day-picker/locale/ko';
import {Calendar} from '@/components/ui/calendar';

const KST_TIME_ZONE = 'Asia/Seoul';
const KST_DATE_FORMATTER = new Intl.DateTimeFormat('en-CA', {
    day: '2-digit',
    month: '2-digit',
    timeZone: KST_TIME_ZONE,
    year: 'numeric',
});
const KOREAN_DATE_FORMATTER = new Intl.DateTimeFormat('ko-KR', {
    day: 'numeric',
    month: 'long',
    timeZone: KST_TIME_ZONE,
    year: 'numeric',
});
const KOREAN_MONTH_FORMATTER = new Intl.DateTimeFormat('ko-KR', {
    month: 'long',
    timeZone: KST_TIME_ZONE,
    year: 'numeric',
});
const KOREAN_WEEKDAY_FORMATTER = new Intl.DateTimeFormat('ko-KR', {
    timeZone: KST_TIME_ZONE,
    weekday: 'narrow',
});

export function MealHistoryCalendar({
    availableDates,
    month,
    onMonthChange,
    onSelect,
    selectedDate,
}: {
    availableDates: ReadonlySet<string>;
    month: string;
    onMonthChange: (month: string) => void;
    onSelect: (date: string) => void;
    selectedDate: string;
}) {
    const selected = parseDateKey(selectedDate);
    const visibleMonth = parseMonthKey(month);
    const hasMeal = (date: Date): boolean => availableDates.has(dateKey(date));

    return (
        <Calendar
            aria-label={`${formatMonth(selected)} 급식 기록 달력`}
            className="w-full p-0 [--cell-size:2.25rem] sm:[--cell-size:2.5rem]"
            month={visibleMonth}
            disabled={(date) => !hasMeal(date)}
            fixedWeeks
            formatters={{
                formatCaption: formatMonth,
                formatWeekdayName: (date) => KOREAN_WEEKDAY_FORMATTER.format(date),
            }}
            labels={{
                labelDayButton: (date, modifiers) => [
                    KOREAN_DATE_FORMATTER.format(date),
                    modifiers.hasMeal ? '급식 기록 있음' : '급식 기록 없음',
                    modifiers.today ? '오늘' : null,
                    modifiers.selected ? '선택됨' : null,
                ].filter(Boolean).join(', '),
                labelGrid: (month) => `${formatMonth(month)} 급식 기록 달력`,
                labelNav: () => '달력 월 이동',
                labelNext: () => '다음 달',
                labelPrevious: () => '이전 달',
            }}
            locale={ko}
            mode="single"
            modifiers={{hasMeal}}
            modifiersClassNames={{
                hasMeal: '[&_button]:bg-primary/10 [&_button]:font-semibold [&_button]:text-primary [&_button]:hover:bg-primary/15',
            }}
            noonSafe
            required
            selected={selected}
            showOutsideDays={false}
            timeZone={KST_TIME_ZONE}
            onSelect={(date) => onSelect(dateKey(date))}
            onMonthChange={(value) => onMonthChange(monthKey(value))}
        />
    );
}

function parseMonthKey(value: string): Date {
    if (!/^\d{4}-(?:0[1-9]|1[0-2])$/u.test(value)) throw new Error('INVALID_MONTH');
    return new Date(`${value}-01T12:00:00+09:00`);
}

function monthKey(value: Date): string {
    return dateKey(value).slice(0, 7);
}

function parseDateKey(value: string): Date {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw new Error('INVALID_DATE');
    const result = new Date(`${value}T12:00:00+09:00`);
    if (dateKey(result) !== value) throw new Error('INVALID_DATE');
    return result;
}

function dateKey(value: Date): string {
    const parts = new Map(
        KST_DATE_FORMATTER.formatToParts(value).map((part) => [part.type, part.value]),
    );
    const year = parts.get('year');
    const month = parts.get('month');
    const day = parts.get('day');
    if (!year || !month || !day) throw new Error('INVALID_DATE');
    return `${year}-${month}-${day}`;
}

function formatMonth(value: Date): string {
    return KOREAN_MONTH_FORMATTER.format(value);
}
