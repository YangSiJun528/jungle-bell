import {
    createContext,
    useContext,
    useMemo,
    type PropsWithChildren,
} from 'react';
import {
    useQuery,
    type UseQueryResult,
} from '@tanstack/react-query';
import type {BrowserAccountSession, DesktopConnectionState} from '@/api/dashboard-api';
import {queryKeys, useDashboardEnvironment} from './dashboard-context';
import {
    dashboardAccountStatus,
    personalAccessState,
    type DashboardAccountStatus,
    type PersonalAccessState,
} from './dashboard-account-state';

interface DashboardAccountContextValue {
    status: DashboardAccountStatus;
    personalAccess: PersonalAccessState;
    connectionQuery: UseQueryResult<DesktopConnectionState, Error>;
    browserSessionQuery: UseQueryResult<BrowserAccountSession | null, Error>;
}

const DashboardAccountContext = createContext<DashboardAccountContextValue | null>(null);

export function DashboardAccountProvider({children}: PropsWithChildren) {
    const {api, platform} = useDashboardEnvironment();
    const connectionQuery = useQuery({
        queryKey: queryKeys.desktopConnection,
        queryFn: () => api.getDesktopConnectionState(),
        enabled: platform.capabilities.desktopAccount,
        staleTime: 60_000,
        refetchInterval: 60_000,
    });
    const browserSessionQuery = useQuery({
        queryKey: queryKeys.accountSession,
        queryFn: () => api.getAccountSession(),
        enabled: platform.kind === 'browser',
        staleTime: 60_000,
        refetchInterval: 60_000,
    });
    const status = dashboardAccountStatus(platform.kind, connectionQuery);
    const personalAccess = personalAccessState(platform.kind, status, browserSessionQuery);
    const value = useMemo<DashboardAccountContextValue>(
        () => ({status, personalAccess, connectionQuery, browserSessionQuery}),
        [browserSessionQuery, connectionQuery, personalAccess, status],
    );

    return (
        <DashboardAccountContext.Provider value={value}>
            {children}
        </DashboardAccountContext.Provider>
    );
}

export function useDashboardAccount(): DashboardAccountContextValue {
    const value = useContext(DashboardAccountContext);
    if (!value) throw new Error('DASHBOARD_ACCOUNT_REQUIRED');
    return value;
}
