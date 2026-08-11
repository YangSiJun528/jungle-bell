import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, test, vi} from 'vitest';
import type {DashboardMealsSnapshot} from '@/dashboard-api';
import {MealHistorySection} from './meal-history-section';

const api = vi.hoisted(() => ({
    getPublicMealHistory: vi.fn(),
}));

vi.mock('@/app/dashboard-context', () => ({
    useDashboardEnvironment: () => ({api}),
}));

const meals: DashboardMealsSnapshot = {
    asOf: '2020-01-03T00:00:00.000Z',
    lastCheckedAt: '2020-01-03T00:00:00.000Z',
    data: {
        dailyMenus: [],
        pinnedMenus: [],
        recentMenus: [{
            id: 'past-lunch',
            title: '2020년 1월 2일 중식 메뉴',
            text: '잡곡밥, 육개장',
            publishedAt: '2020-01-02T03:00:00.000Z',
            permalink: null,
            images: [],
        }],
        historyNextBefore: '2020-01-02T03:00:00.000Z|past-lunch',
    },
};

function renderHistory(): string {
    return renderToStaticMarkup(
        <QueryClientProvider client={new QueryClient()}>
            <MealHistorySection meals={meals}/>
        </QueryClientProvider>,
    );
}

describe('MealHistorySection', () => {
    test('날짜 선택 달력, 선택 날짜 식단, 이전 기록 로드를 한 섹션에서 제공한다', () => {
        const markup = renderHistory();

        expect(markup).toContain('aria-labelledby="meal-history-title"');
        expect(markup).toContain('2020년 1월 급식 기록 달력');
        expect(markup).toContain('2020년 1월 2일');
        expect(markup).toContain('잡곡밥, 육개장');
        expect(markup).toContain('이전 기록 더 불러오기');
    });
});
