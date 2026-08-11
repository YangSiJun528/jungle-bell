import {describe, expect, it} from 'vitest';
import type {DashboardMealsSnapshot} from '@/api/dashboard-api';
import {
    calendarMonthCells,
    mealsGroupedByDate,
    todayMealSlots,
    weekKeyForDate,
    weekRangeLabel,
    weeklyMenuForDate,
} from './meal-view';

const snapshot: DashboardMealsSnapshot = {
    asOf: '2026-08-11T00:00:00.000Z',
    lastCheckedAt: null,
    data: {
        dailyMenus: [
            {id: 'dinner', title: '8월 11일 석식', text: '저녁', publishedAt: null, permalink: null},
            {id: 'lunch', title: '8월 11일 중식', text: '점심', publishedAt: null, permalink: null},
        ],
        pinnedMenus: [],
        recentMenus: [
            {id: 'lunch', title: '중복', text: '중복', publishedAt: null, permalink: null},
            {id: 'older', title: '8월 10일 중식', text: '이전', publishedAt: null, permalink: null},
        ],
    },
};

describe('todayMealSlots', () => {
    it('중식과 석식 슬롯을 고정하고 게시되지 않은 식사는 빈 슬롯으로 둔다', () => {
        const slots = todayMealSlots([snapshot.data.dailyMenus[1]!]);

        expect(slots.map(({period, meal}) => [period, meal?.id ?? null])).toEqual([
            ['중식', 'lunch'],
            ['석식', null],
        ]);
    });
});

describe('급식 이력 보조 모델', () => {
    it('급식 기록을 날짜별로 묶고 식사 순서로 정렬한다', () => {
        const grouped = mealsGroupedByDate(snapshot.data.dailyMenus, new Date('2026-08-11T03:00:00.000Z'));
        expect(grouped.get('2026-08-11')?.map((meal) => meal.id)).toEqual(['lunch', 'dinner']);
    });

    it('달력은 6주 그리드와 정확한 날짜 키를 제공한다', () => {
        const cells = calendarMonthCells('2026-08');
        expect(cells).toHaveLength(42);
        expect(cells.find((cell) => cell?.date === '2026-08-01')?.day).toBe(1);
        expect(cells.find((cell) => cell?.date === '2026-08-31')?.day).toBe(31);
    });

    it('주간 식단의 월요일부터 일요일까지를 표시한다', () => {
        expect(weekRangeLabel('2026-08-10')).toBe('8월 10일 ~ 8월 16일');
    });

    it('선택한 날짜가 속한 월요일 주차의 저장된 급식표를 찾는다', () => {
        const weekly = [{
            weekKey: '2026-08-10',
            contentSha: 'weekly-sha',
            post: {
                id: 'weekly', title: '8월 2주차 식단표', text: '',
                publishedAt: '2026-08-10T00:00:00.000Z', permalink: null,
            },
        }, {
            weekKey: '2026-08-17',
            contentSha: 'next-week-sha',
            post: {
                id: 'next-weekly', title: '8월 3주차 식단표', text: '',
                publishedAt: '2026-08-17T00:00:00.000Z', permalink: null,
            },
        }];

        expect(weekKeyForDate('2026-08-16')).toBe('2026-08-10');
        expect(weeklyMenuForDate(weekly, '2026-08-13')?.post.id).toBe('weekly');
        expect(weeklyMenuForDate(weekly, '2026-08-18')?.post.id).toBe('next-weekly');
        expect(weeklyMenuForDate(weekly, '2026-08-24')).toBeNull();
    });
});
