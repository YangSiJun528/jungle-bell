import {queryOptions} from '@tanstack/react-query';

import {
    type DashboardApi,
    parseDashboardLaundrySnapshot,
    parseDashboardMealsSnapshot,
} from '@/api/dashboard-api';

export const laundryQueryContract = {
    queryKey: ['campus', 'laundry'] as const,
    freshnessMs: 30_000,
    parse: parseDashboardLaundrySnapshot,
};

export const mealsQueryContract = {
    queryKey: ['campus', 'meals'] as const,
    freshnessMs: 5 * 60_000,
    parse: parseDashboardMealsSnapshot,
};

export function laundryQueryOptions(api: Pick<DashboardApi, 'getPublicLaundry'>) {
    return queryOptions({
        queryKey: laundryQueryContract.queryKey,
        queryFn: () => api.getPublicLaundry(),
        staleTime: laundryQueryContract.freshnessMs,
        refetchInterval: laundryQueryContract.freshnessMs,
    });
}

export function mealsQueryOptions(api: Pick<DashboardApi, 'getPublicMeals'>) {
    return queryOptions({
        queryKey: mealsQueryContract.queryKey,
        queryFn: () => api.getPublicMeals(),
        staleTime: mealsQueryContract.freshnessMs,
        refetchInterval: mealsQueryContract.freshnessMs,
    });
}
