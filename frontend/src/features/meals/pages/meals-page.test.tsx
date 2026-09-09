import {readFileSync} from 'node:fs';

import {describe, expect, it} from 'vitest';

const source = readFileSync(new URL('./meals-page.tsx', import.meta.url), 'utf8');
const historySource = readFileSync(
    new URL('../components/meal-history-section.tsx', import.meta.url),
    'utf8',
);

describe('MealsPage information architecture', () => {
    it('오늘 사진, 주간 급식표, 날짜별 과거 기록을 독립 섹션으로 둔다', () => {
        expect(source).toContain('aria-labelledby="today-meals-title"');
        expect(source).toContain('<TodayMealGrid meals={todayMeals} />');
        expect(source).toContain('aria-labelledby="weekly-meal-title"');
        expect(source).toContain('<WeeklyMealMenu');
        expect(source).toContain('<MealHistorySection meals={meals.data} />');
        expect(historySource).toContain('aria-labelledby="meal-history-title"');
        expect(historySource).toContain('<MealHistoryCalendar');
        expect(historySource).not.toContain('MealHistoryLoadMore');
    });

    it('급식 섹션 사이에 일관된 세로 여백을 둔다', () => {
        expect(source).toMatch(
            /<div className="space-y-6" data-meals-sections="true">[\s\S]*aria-labelledby="today-meals-title"[\s\S]*aria-labelledby="weekly-meal-title"[\s\S]*<MealHistorySection/u,
        );
    });

    it('오늘 급식에 주간 pinned fallback을 쓰지 않고 Badge나 그라데이션을 사용하지 않는다', () => {
        expect(source).not.toMatch(/todayMeals[\s\S]{0,200}pinnedMenus/u);
        expect(source).not.toMatch(/\bBadge\b|gradient/u);
    });

    it('과거 기록만 기능 컴포넌트로 위임하고 알림 설정은 중복하지 않는다', () => {
        expect(source).not.toContain('MealPreferencesSection');
        expect(source).not.toMatch(/useInfiniteQuery|useMutation|useQueryClient/u);
        expect(source).not.toContain('PersonalSurface');
        expect(historySource).toContain('setVisibleMonthKey(month)');
    });

    it('page header 밖의 공통 local async boundary로 식단 실패를 격리한다', () => {
        const pageSource = source.slice(source.indexOf('export function MealsPage()'));

        expect(pageSource.indexOf('<PageHeader')).toBeLessThan(
            pageSource.indexOf('<MealsFeatureBoundary'),
        );
        expect(source).toContain(
            "import {AsyncBoundary} from '@/components/dashboard/async-boundary'",
        );
        expect(source).toContain('<AsyncBoundary');
        expect(source).toContain('regionLabel="급식 데이터"');
        expect(source).not.toContain('<QueryErrorResetBoundary>');
        expect(source).not.toContain('isRefreshSuccess: manualRefresh.isSuccess');
    });
});
