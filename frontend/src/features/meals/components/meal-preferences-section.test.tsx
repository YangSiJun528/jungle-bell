import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, test, vi} from 'vitest';

import type {MealPreferences} from '@/api/dashboard-api';

import {MealPreferencesSection} from './meal-preferences-section';

const {api, queryKeys} = vi.hoisted(() => ({
    api: {
        getMealPreferences: vi.fn<() => Promise<MealPreferences>>(),
        updateMealPreferences: vi.fn<(input: MealPreferences) => Promise<MealPreferences>>(),
    },
    queryKeys: {
        mealPreferences: ['personal', 'meal-preferences'] as const,
    },
}));

vi.mock('@/app/dashboard-context', () => ({
    queryKeys,
    useDashboardEnvironment: () => ({api}),
}));

vi.mock('@/app/dashboard-account', () => ({
    useDashboardAccount: () => ({personalAccess: {status: 'connected'}}),
}));

const preferences: MealPreferences = {
    enabled: true,
    lunch: true,
    dinner: true,
    updatedAtEpochMs: 1,
};

function renderPreferences(): string {
    const client = new QueryClient();
    client.setQueryData(queryKeys.mealPreferences, preferences);
    return renderToStaticMarkup(
        <QueryClientProvider client={client}>
            <MealPreferencesSection />
        </QueryClientProvider>,
    );
}

describe('MealPreferencesSection', () => {
    test('개인 화면에서 식사 시간대별 알림 설정을 표시한다', () => {
        const markup = renderPreferences();

        expect(markup).toContain('급식 알림');
        expect(markup).toContain('aria-label="급식 알림 사용"');
        expect(markup).not.toContain('aria-label="조식"');
        expect(markup).toContain('aria-label="중식"');
        expect(markup).toContain('aria-label="석식"');
        expect(markup).toContain('설정 저장');
    });
});
