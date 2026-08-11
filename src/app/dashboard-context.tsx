import {
    createContext,
    useContext,
} from 'react';
import {createDashboardApi, type DashboardApi} from '@/api/dashboard-api';
import {resolveDashboardSurface, type DashboardSurface} from '@/app/surface';
import {detectDashboardRuntime, type DashboardRuntime} from '@/app/runtime';
import {
    type CampusDataHealth,
    type CampusDataKind,
} from './campus-data-health';
import {
    laundryQueryContract,
    mealsQueryContract,
} from './campus-query-options';

export const queryKeys = {
    laundry: laundryQueryContract.queryKey,
    meals: mealsQueryContract.queryKey,
    attendance: (surface: 'desktop' | 'companion') => ['attendance', surface] as const,
    homeOverview: ['home-overview'] as const,
    desktopConnection: ['desktop-connection'] as const,
    desktopSettings: ['desktop-settings'] as const,
    notifications: (surface: 'desktop' | 'companion') => ['notifications', surface] as const,
    attendancePreferences: ['personal', 'attendance-preferences'] as const,
    mealPreferences: ['personal', 'meal-preferences'] as const,
    laundryWatches: ['personal', 'laundry-watches'] as const,
    laundryQueue: ['personal', 'laundry-queue'] as const,
    mobileSessions: ['mobile-sessions'] as const,
};

export interface DashboardEnvironment {
    api: DashboardApi;
    runtime: DashboardRuntime;
    surface: DashboardSurface;
}

export const DashboardEnvironmentContext = createContext<DashboardEnvironment | null>(null);
export const CampusDataHealthContext = createContext<CampusDataHealth | null>(null);

export function createEnvironment(): DashboardEnvironment {
    const runtime = detectDashboardRuntime();
    return {
        runtime,
        surface: resolveDashboardSurface({
            runningInTauri: runtime.runningInTauri,
            standalone: runtime.standalone,
        }),
        api: createDashboardApi({desktopRuntime: runtime.runningInTauri}),
    };
}

export function useDashboardEnvironment(): DashboardEnvironment {
    const value = useContext(DashboardEnvironmentContext);
    if (!value) throw new Error('DASHBOARD_ENVIRONMENT_REQUIRED');
    return value;
}

export function useCampusDataIssue(kind: CampusDataKind) {
    const value = useContext(CampusDataHealthContext);
    if (!value) throw new Error('CAMPUS_DATA_HEALTH_REQUIRED');
    return value[kind];
}
