import {describe, expect, it, vi} from 'vitest';
import type {
    DashboardLaundrySnapshot,
    DashboardMealsSnapshot,
} from '@/api/dashboard-api';
import {
    laundryQueryContract,
    laundryQueryOptions,
    mealsQueryContract,
    mealsQueryOptions,
} from './campus-query-options';

const laundrySnapshot: DashboardLaundrySnapshot = {
    schemaVersion: 1,
    asOf: '2026-08-11T00:00:00.000Z',
    final: true,
    quality: {
        collection: 'SUCCESS',
        sourceFreshness: 'REFRESH_OBSERVED',
        lastCheckedAt: '2026-08-11T00:00:00.000Z',
        expectedRefreshIntervalSeconds: 300,
    },
    machines: [],
    capacity: null,
};

const mealsSnapshot: DashboardMealsSnapshot = {
    asOf: '2026-08-11T00:00:00.000Z',
    lastCheckedAt: '2026-08-11T00:00:00.000Z',
    data: {
        schemaVersion: 2,
        dailyMenus: [],
        pinnedMenus: [],
        recentMenus: [],
        currentWeeklyMenu: null,
        weeklyMenus: [],
        historyNextBefore: null,
    },
};

describe('campus query options', () => {
    it('keeps each query key, parser, and freshness policy in one typed contract', () => {
        expect(laundryQueryContract.queryKey).toEqual(['campus', 'laundry']);
        expect(laundryQueryContract.freshnessMs).toBe(30_000);
        expect(laundryQueryContract.parse(laundrySnapshot)).toEqual(laundrySnapshot);

        expect(mealsQueryContract.queryKey).toEqual(['campus', 'meals']);
        expect(mealsQueryContract.freshnessMs).toBe(5 * 60_000);
        expect(mealsQueryContract.parse(mealsSnapshot)).toEqual(mealsSnapshot);
    });

    it('builds TanStack queryOptions from the same laundry contract', async () => {
        const getPublicLaundry = vi.fn(async () => laundrySnapshot);
        const options = laundryQueryOptions({getPublicLaundry});

        expect(options.queryKey).toBe(laundryQueryContract.queryKey);
        expect(options.staleTime).toBe(laundryQueryContract.freshnessMs);
        expect(options.refetchInterval).toBe(laundryQueryContract.freshnessMs);
        await expect(options.queryFn?.({} as never)).resolves.toEqual(laundrySnapshot);
        expect(getPublicLaundry).toHaveBeenCalledOnce();
    });

    it('builds TanStack queryOptions from the same meals contract', async () => {
        const getPublicMeals = vi.fn(async () => mealsSnapshot);
        const options = mealsQueryOptions({getPublicMeals});

        expect(options.queryKey).toBe(mealsQueryContract.queryKey);
        expect(options.staleTime).toBe(mealsQueryContract.freshnessMs);
        expect(options.refetchInterval).toBe(mealsQueryContract.freshnessMs);
        await expect(options.queryFn?.({} as never)).resolves.toEqual(mealsSnapshot);
        expect(getPublicMeals).toHaveBeenCalledOnce();
    });
});
