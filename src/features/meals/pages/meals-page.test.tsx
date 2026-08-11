import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';

const source = readFileSync(new URL('./meals-page.tsx', import.meta.url), 'utf8');
const historySource = readFileSync(
    new URL('../components/meal-history-section.tsx', import.meta.url),
    'utf8',
);
const preferencesSource = readFileSync(
    new URL('../components/meal-preferences-section.tsx', import.meta.url),
    'utf8',
);

describe('MealsPage information architecture', () => {
    it('오늘 사진, 주간 급식표, 날짜별 과거 기록을 독립 섹션으로 둔다', () => {
        expect(source).toContain('aria-labelledby="today-meals-title"');
        expect(source).toContain('<MealPostCard eagerImage=');
        expect(source).toContain('aria-labelledby="weekly-meal-title"');
        expect(source).toContain('<WeeklyMealMenu');
        expect(source).toContain('<MealHistorySection meals={meals.data}/>');
        expect(historySource).toContain('aria-labelledby="meal-history-title"');
        expect(historySource).toContain('<MealHistoryCalendar');
        expect(historySource.match(/<MealHistoryLoadMore/g)).toHaveLength(2);
    });

    it('오늘 급식에 주간 pinned fallback을 쓰지 않고 Badge나 그라데이션을 사용하지 않는다', () => {
        expect(source).not.toMatch(/sections\.today[\s\S]{0,200}pinnedMenus/u);
        expect(source).not.toMatch(/\bBadge\b|gradient/u);
    });

    it('과거 기록과 개인 알림 상태를 페이지에서 독립된 기능 컴포넌트로 위임한다', () => {
        expect(source).toContain('<MealPreferencesSection surface={personal}/>');
        expect(source).not.toMatch(/useInfiniteQuery|useMutation|useQueryClient/u);
        expect(source).not.toContain('as PersonalSurface');
        expect(historySource).toContain('key={activeHistoryDate.slice(0, 7)}');
        expect(preferencesSource).toContain('{surface: PersonalSurface}');
        expect(preferencesSource).not.toContain('as PersonalSurface');
    });
});
