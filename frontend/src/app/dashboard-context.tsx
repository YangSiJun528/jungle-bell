import {
    createContext,
    useContext,
} from 'react';
import type {QueryClient} from '@tanstack/react-query';
import {createDashboardApi, type DashboardApi} from '@/api/dashboard-api';
import type {PlatformAdapter} from '@/platform/contracts';
import {
    laundryQueryContract,
    mealsQueryContract,
} from './campus-query-options';

export const queryKeys = {
    laundry: laundryQueryContract.queryKey,
    meals: mealsQueryContract.queryKey,
    attendance: (platform: 'browser' | 'desktop') => ['attendance', platform] as const,
    accountSession: ['account-session'] as const,
    desktopConnection: ['desktop-connection'] as const,
    desktopSettings: ['desktop-settings'] as const,
    notifications: (platform: 'browser' | 'desktop') => ['notifications', platform] as const,
    pushSetup: ['push-setup'] as const,
    attendancePreferences: ['personal', 'attendance-preferences'] as const,
    mealPreferences: ['personal', 'meal-preferences'] as const,
    laundryWatches: ['personal', 'laundry-watches'] as const,
    mobileSessions: ['mobile-sessions'] as const,
};

export interface DashboardEnvironment {
    api: DashboardApi;
    platform: PlatformAdapter;
}

export const DashboardEnvironmentContext = createContext<DashboardEnvironment | null>(null);

export function createEnvironment(platform: PlatformAdapter): DashboardEnvironment {
    return {
        platform,
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

export function removeBrowserPersonalQueries(client: QueryClient): void {
    client.removeQueries({queryKey: ['personal']});
    client.removeQueries({queryKey: queryKeys.attendance('browser'), exact: true});
    client.removeQueries({queryKey: queryKeys.notifications('browser'), exact: true});
    client.removeQueries({queryKey: queryKeys.mobileSessions, exact: true});
    client.removeQueries({queryKey: ['pairing-status']});
    client.setQueryData(queryKeys.accountSession, null);
}

export async function refreshBrowserPersonalQueries(client: QueryClient): Promise<void> {
    await client.invalidateQueries({queryKey: queryKeys.accountSession, exact: true});
    await Promise.all([
        client.invalidateQueries({queryKey: ['personal']}),
        client.invalidateQueries({queryKey: queryKeys.attendance('browser'), exact: true}),
        client.invalidateQueries({queryKey: queryKeys.notifications('browser'), exact: true}),
    ]);
}
