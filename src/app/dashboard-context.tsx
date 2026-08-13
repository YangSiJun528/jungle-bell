import {
    createContext,
    useContext,
} from 'react';
import type {QueryClient} from '@tanstack/react-query';
import {createDashboardApi, type DashboardApi} from '@/api/dashboard-api';
import {detectDashboardRuntime, type DashboardRuntime} from '@/app/runtime';
import {createPlatformAdapter, type PlatformAdapter} from '@/platform/platform-adapter';
import {
    laundryQueryContract,
    mealsQueryContract,
} from './campus-query-options';

export const queryKeys = {
    laundry: laundryQueryContract.queryKey,
    meals: mealsQueryContract.queryKey,
    attendance: (platform: 'browser' | 'desktop') => ['attendance', platform] as const,
    desktopConnection: ['desktop-connection'] as const,
    desktopSettings: ['desktop-settings'] as const,
    notifications: (platform: 'browser' | 'desktop') => ['notifications', platform] as const,
    attendancePreferences: ['personal', 'attendance-preferences'] as const,
    mealPreferences: ['personal', 'meal-preferences'] as const,
    laundryWatches: ['personal', 'laundry-watches'] as const,
    mobileSessions: ['mobile-sessions'] as const,
};

export interface DashboardEnvironment {
    api: DashboardApi;
    platform: PlatformAdapter;
    runtime: DashboardRuntime;
}

export const DashboardEnvironmentContext = createContext<DashboardEnvironment | null>(null);

export function createEnvironment(): DashboardEnvironment {
    const runtime = detectDashboardRuntime();
    const platform = createPlatformAdapter({runningInTauri: runtime.runningInTauri});
    return {
        platform,
        runtime,
        api: createDashboardApi({platformAdapter: platform}),
    };
}

export function useDashboardEnvironment(): DashboardEnvironment {
    const value = useContext(DashboardEnvironmentContext);
    if (!value) throw new Error('DASHBOARD_ENVIRONMENT_REQUIRED');
    return value;
}

export function removeDesktopIdentityQueries(client: QueryClient): void {
    client.removeQueries({queryKey: ['personal']});
    client.removeQueries({queryKey: queryKeys.desktopConnection, exact: true});
    client.removeQueries({queryKey: queryKeys.attendance('desktop'), exact: true});
    client.removeQueries({queryKey: queryKeys.notifications('desktop'), exact: true});
    client.removeQueries({queryKey: queryKeys.mobileSessions, exact: true});
    client.removeQueries({queryKey: ['pairing-status']});
}
