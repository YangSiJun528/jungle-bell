import {readFileSync} from 'node:fs';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it} from 'vitest';
import type {DashboardWeeklyMealMenu} from '@/api/dashboard-api';
import {weeklyMenuForDate} from '../lib/meal-view';
import {MealHistoryCalendar} from './meal-history-calendar';
import {WeeklyMealMenu} from './weekly-meal-menu';

const source = readFileSync(new URL('./meal-history-calendar.tsx', import.meta.url), 'utf8');
const calendarSource = readFileSync(
    new URL('../../../components/ui/calendar.tsx', import.meta.url),
    'utf8',
);

describe('MealHistoryCalendar', () => {
    it('급식이 있는 날짜와 선택한 날짜를 구분한다', () => {
        const markup = renderToStaticMarkup(
            <MealHistoryCalendar
                availableDates={new Set(['2026-08-10', '2026-08-11'])}
                month="2026-08"
                selectedDate="2026-08-10"
                onSelect={() => undefined}
                onMonthChange={() => undefined}
            />,
        );

        expect(markup).toContain('aria-label="2026년 8월 급식 기록 달력"');
        expect(markup).toContain('data-selected-single="true"');
        expect(markup).toContain('2026년 8월 10일, 급식 기록 있음, 선택됨');
        expect(markup).toContain('2026년 8월 13일, 급식 기록 없음');
        expect(markup).toContain('data-day="2026-08-13"');
        expect(markup).toContain('data-disabled="true"');
        expect(markup).toContain('이전 달');
        expect(markup).toContain('다음 달');
        expect(markup).toContain('aria-label="달력 월 이동"');
        expect(markup).not.toMatch(/<p(?:\s|>)/u);
    });

    it('공식 ShadCN Calendar에 날짜 선택과 월 이동을 위임한다', () => {
        expect(source).toContain("import {Calendar} from '@/components/ui/calendar'");
        expect(source).toContain('month={visibleMonth}');
        expect(source).toContain('onMonthChange={(value) => onMonthChange(monthKey(value))}');
        expect(source).toContain("modifiers.today ? '오늘' : null");
        expect(source).not.toContain('navLayout="around"');
        expect(source).not.toContain('calendarMonthCells');
        expect(source).not.toContain('useEffect');
        expect(calendarSource).toContain('import { Button, buttonVariants }');
        expect(calendarSource.match(/buttonVariants\(\{ variant: buttonVariant \}\)/gu)).toHaveLength(2);
        expect(calendarSource).not.toContain('PreviousMonthButton:');
        expect(calendarSource).not.toContain('NextMonthButton:');
    });

    it('날짜 버튼을 클릭하면 선택 날짜에 맞는 다른 주차 급식표로 전환한다', () => {
        const weeklyMenus: DashboardWeeklyMealMenu[] = [
            weeklyMenu('2026-08-10', '둘째 주'),
            weeklyMenu('2026-08-17', '셋째 주'),
        ];
        let selectedDate = '2026-08-11';
        const before = weeklyMenuForDate(weeklyMenus, selectedDate)!;
        const calendar = MealHistoryCalendar({
            availableDates: new Set(['2026-08-11', '2026-08-18']),
            month: '2026-08',
            selectedDate,
            onSelect: (date) => {
                selectedDate = date;
            },
            onMonthChange: () => undefined,
        });

        (calendar.props as {onSelect: (date: Date) => void}).onSelect(new Date(2026, 7, 18));
        const after = weeklyMenuForDate(weeklyMenus, selectedDate)!;
        const markup = renderToStaticMarkup(
            <WeeklyMealMenu meal={after.post} weekKey={after.weekKey}/>,
        );

        expect(before.post.title).toBe('둘째 주');
        expect(selectedDate).toBe('2026-08-18');
        expect(markup).toContain('셋째 주');
        expect(markup).toContain('8월 17일 ~ 8월 23일');
        expect(markup).not.toContain('둘째 주');
    });
});

function weeklyMenu(weekKey: string, title: string): DashboardWeeklyMealMenu {
    return {
        weekKey,
        contentSha: `${weekKey}-sha`,
        post: {
            id: weekKey,
            title,
            text: '',
            publishedAt: `${weekKey}T00:00:00.000Z`,
            permalink: null,
            images: [],
        },
    };
}
