import {readFileSync} from 'node:fs';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it} from 'vitest';
import type {DashboardWeeklyMealMenu} from '@/api/dashboard-api';
import {weeklyMenuForDate} from '../lib/meal-view';
import {MealHistoryCalendar, MealHistoryDayButton} from './meal-history-calendar';
import {WeeklyMealMenu} from './weekly-meal-menu';

const source = readFileSync(new URL('./meal-history-calendar.tsx', import.meta.url), 'utf8');

describe('MealHistoryCalendar', () => {
    it('급식이 있는 날짜와 선택한 날짜를 구분한다', () => {
        const markup = renderToStaticMarkup(
            <MealHistoryCalendar
                availableDates={new Set(['2026-08-10', '2026-08-11'])}
                selectedDate="2026-08-10"
                onSelect={() => undefined}
            />,
        );

        expect(markup).toContain('aria-label="2026년 8월 급식 기록 달력"');
        expect(markup).toContain('data-has-meal="true"');
        expect(markup).toContain('aria-pressed="true"');
        expect(markup).toContain('이전 달');
        expect(markup).toContain('다음 달');
        expect(markup).not.toMatch(/<p(?:\s|>)/u);
    });

    it('선택 날짜는 초기 월에만 사용하고 월 이동 상태를 effect로 되돌리지 않는다', () => {
        expect(source).toContain('useState(() => selectedDate.slice(0, 7))');
        expect(source).not.toContain('useEffect');
    });

    it('날짜 버튼을 클릭하면 선택 날짜에 맞는 다른 주차 급식표로 전환한다', () => {
        const weeklyMenus: DashboardWeeklyMealMenu[] = [
            weeklyMenu('2026-08-10', '둘째 주'),
            weeklyMenu('2026-08-17', '셋째 주'),
        ];
        let selectedDate = '2026-08-11';
        const before = weeklyMenuForDate(weeklyMenus, selectedDate)!;
        const button = MealHistoryDayButton({
            cell: {date: '2026-08-18', day: 18},
            hasMeal: true,
            selected: false,
            onSelect: (date) => {
                selectedDate = date;
            },
        });

        (button.props as {onClick: () => void}).onClick();
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
