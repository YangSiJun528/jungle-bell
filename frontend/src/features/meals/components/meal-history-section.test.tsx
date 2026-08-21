import {readFileSync} from 'node:fs';

import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, test, vi} from 'vitest';

import type {DashboardMealsSnapshot} from '@/api/dashboard-api';
import {kstDateKey} from '@/domain/meals/today';

import {MealHistorySection} from './meal-history-section';

const source = readFileSync(new URL('./meal-history-section.tsx', import.meta.url), 'utf8');

const api = vi.hoisted(() => ({
    getPublicMealHistoryMonth: vi.fn(async () => ({posts: []})),
}));

vi.mock('@/app/dashboard-context', () => ({
    useDashboardEnvironment: () => ({api}),
}));

const meals: DashboardMealsSnapshot = {
    asOf: '2020-01-03T00:00:00.000Z',
    lastCheckedAt: '2020-01-03T00:00:00.000Z',
    data: {
        schemaVersion: 2,
        dailyMenus: [],
        pinnedMenus: [],
        recentMenus: [
            {
                id: 'past-lunch',
                title: '2020년 1월 2일 중식 메뉴',
                text: '잡곡밥, 육개장',
                publishedAt: '2020-01-02T03:00:00.000Z',
                permalink: null,
                images: [],
            },
        ],
        currentWeeklyMenu: null,
        weeklyMenus: [
            {
                weekKey: '2019-12-30',
                contentSha: 'weekly-sha',
                post: {
                    id: 'past-weekly',
                    title: '2019년 12월 30일 주차 급식표',
                    text: '',
                    publishedAt: '2019-12-30T00:00:00.000Z',
                    permalink: null,
                    images: [],
                },
            },
        ],
    },
};

function renderHistory(snapshot = meals): string {
    const client = new QueryClient();
    client.setQueryData(['campus', 'meals', 'history', '2020-01'], {posts: []});
    client.setQueryData(['campus', 'meals', 'history', kstDateKey(new Date()).slice(0, 7)], {
        posts: [],
    });
    return renderToStaticMarkup(
        <QueryClientProvider client={client}>
            <MealHistorySection meals={snapshot} />
        </QueryClientProvider>,
    );
}

describe('MealHistorySection', () => {
    test('날짜 선택 달력과 선택 날짜 식단을 한 섹션에서 제공한다', () => {
        const markup = renderHistory();

        expect(markup).toContain('aria-labelledby="meal-history-title"');
        expect(markup).toContain('2020년 1월 급식 기록 달력');
        expect(markup).toContain('2020년 1월 2일');
        expect(markup).toContain('잡곡밥, 육개장');
        expect(markup).toContain('선택한 주 급식표');
        expect(markup).toContain('2019년 12월 30일 주차 급식표');
        expect(markup).not.toContain('이전 기록 더 불러오기');
        expect(markup).toContain('data-meal-history-overview="true"');
        expect(markup).toContain('data-meal-history-weekly="true"');
        expect(source).toContain('lg:grid-cols-[minmax(17rem,20rem)_minmax(0,1fr)]');
        expect(source).toContain('className="grid gap-4 sm:grid-cols-2"');
        expect(source).not.toContain('lg:grid-cols-1');
        expect(source).toMatch(
            /data-meal-history-overview="true"[\s\S]*<\/div>\s*<section[\s\S]*data-meal-history-weekly="true"/u,
        );
    });

    test('선택한 날짜의 주간 급식표가 저장되지 않았으면 고정된 빈 상태를 표시한다', () => {
        const markup = renderHistory({
            ...meals,
            data: {...meals.data, weeklyMenus: []},
        });

        expect(markup).toContain('선택한 주 급식표');
        expect(markup).toContain('저장된 주간 급식표가 없습니다.');
    });

    test('기록이 없는 달에도 같은 overview grid와 주간 식단 영역을 유지한다', () => {
        const markup = renderHistory({
            ...meals,
            data: {
                ...meals.data,
                dailyMenus: [],
                recentMenus: [],
                weeklyMenus: [],
            },
        });

        expect(markup).toContain('data-meal-history-overview="true"');
        expect(markup).toContain('data-meal-history-weekly="true"');
        expect(markup).toContain('lg:grid-cols-[minmax(17rem,20rem)_minmax(0,1fr)]');
        expect(markup).toContain('선택한 날짜 식단');
        expect(markup).toContain('이 달에 저장된 급식 기록이 없습니다.');
        expect(markup).toContain('저장된 주간 급식표가 없습니다.');
    });

    test('달력에서 선택한 날짜를 주간 급식표 선택에도 사용한다', () => {
        expect(source).toContain('onSelect={setSelectedHistoryDate}');
        expect(source).toMatch(/weeklyMenuForDate\([\s\S]*activeHistoryDate/u);
    });

    test('달을 이동하면 해당 달 기록을 캐시 가능한 월 단위 쿼리로 가져온다', () => {
        expect(source).toContain("queryKey: ['campus', 'meals', 'history', visibleMonthKey]");
        expect(source).toContain('api.getPublicMealHistoryMonth(visibleMonthKey)');
        expect(source).toContain('const changeMonth = (month: string) => {');
        expect(source).toContain('setVisibleMonthKey(month)');
        expect(source).toContain('useSuspenseQuery({');
        expect(source).toContain('<AsyncBoundary');
        expect(source).not.toContain('useInfiniteQuery');
        expect(source).not.toContain('MealHistoryLoadMore');
    });
});
