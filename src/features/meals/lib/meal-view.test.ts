import {describe, expect, it} from 'vitest';
import type {DashboardMealsSnapshot} from '@/dashboard-api';
import {
    calendarMonthCells,
    mealPeriodLabel,
    mealServiceDate,
    mealsGroupedByDate,
    selectMealSections,
    weekRangeLabel,
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

describe('selectMealSections', () => {
    it('오늘 식단을 식사 순서로 정렬하고 최근 목록에서 중복을 제거한다', () => {
        const result = selectMealSections(snapshot, new Date('2026-08-11T03:00:00.000Z'));
        expect(result.today.map((meal) => meal.id)).toEqual(['lunch', 'dinner']);
        expect(result.recent.map((meal) => meal.id)).toEqual(['older']);
    });

    it('API의 daily 목록이 전날 데이터여도 오늘 식단이나 주간표로 오표시하지 않는다', () => {
        const staleDaily: DashboardMealsSnapshot = {
            ...snapshot,
            data: {
                dailyMenus: [{
                    id: 'yesterday', title: '8월 10일 중식', text: '어제 메뉴',
                    publishedAt: '2026-08-10T02:00:00.000Z', permalink: null,
                }],
                pinnedMenus: [{
                    id: 'weekly', title: '8월 2주차 식단표', text: '',
                    publishedAt: '2026-08-10T00:00:00.000Z', permalink: null,
                }],
                recentMenus: [],
            },
        };

        const result = selectMealSections(staleDaily, new Date('2026-08-11T03:00:00.000Z'));
        expect(result.today).toEqual([]);
        expect(result.recent.map((meal) => meal.id)).toEqual(['yesterday']);
    });
});

describe('mealPeriodLabel', () => {
    it.each([
        ['오늘 조식', '조식'],
        ['오늘 중식', '중식'],
        ['오늘 석식', '석식'],
        [null, '식단'],
    ])('%s를 %s으로 표시한다', (title, expected) => {
        expect(mealPeriodLabel(title)).toBe(expected);
    });
});

describe('mealServiceDate', () => {
    it('게시 제목의 월일을 발행 시각의 KST 연도와 결합한다', () => {
        expect(mealServiceDate({
            id: 'lunch', title: '8월 10일(월) 중식 메뉴', text: '',
            publishedAt: '2026-08-10T02:07:38.000Z', permalink: null,
        })).toBe('2026-08-10');
    });

    it('제목에 날짜가 없으면 발행 시각의 KST 날짜를 쓴다', () => {
        expect(mealServiceDate({
            id: 'lunch', title: '오늘 중식', text: '',
            publishedAt: '2026-08-10T16:00:00.000Z', permalink: null,
        })).toBe('2026-08-11');
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
});
