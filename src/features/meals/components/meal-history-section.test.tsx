import {readFileSync} from 'node:fs';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, test, vi} from 'vitest';
import type {DashboardMealsSnapshot} from '@/api/dashboard-api';
import {MealHistorySection} from './meal-history-section';

const source = readFileSync(new URL('./meal-history-section.tsx', import.meta.url), 'utf8');

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
        schemaVersion: 2,
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
        currentWeeklyMenu: null,
        weeklyMenus: [{
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
        }],
        historyNextBefore: '2020-01-02T03:00:00.000Z|past-lunch',
    },
};

function renderHistory(snapshot = meals): string {
    return renderToStaticMarkup(
        <QueryClientProvider client={new QueryClient()}>
            <MealHistorySection meals={snapshot}/>
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
        expect(markup).toContain('선택한 주 급식표');
        expect(markup).toContain('2019년 12월 30일 주차 급식표');
        expect(markup).toContain('이전 기록 더 불러오기');
        expect(markup).toContain('</h2><div class="grid items-start');
    });

    test('선택한 날짜의 주간 급식표가 저장되지 않았으면 고정된 빈 상태를 표시한다', () => {
        const markup = renderHistory({
            ...meals,
            data: {...meals.data, weeklyMenus: []},
        });

        expect(markup).toContain('선택한 주 급식표');
        expect(markup).toContain('저장된 주간 급식표가 없습니다.');
    });

    test('달력에서 선택한 날짜를 주간 급식표 선택에도 사용한다', () => {
        expect(source).toContain('onSelect={setSelectedHistoryDate}');
        expect(source).toMatch(/weeklyMenuForDate\([\s\S]*activeHistoryDate/u);
    });
});
