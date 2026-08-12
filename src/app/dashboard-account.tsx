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
import type {DesktopConnectionState} from '@/api/dashboard-api';
import {queryKeys, useDashboardEnvironment} from './dashboard-context';
import type {DashboardSurfaceKind} from './surface';

export type ServerSessionStatus =
    | 'not-applicable'
    | 'checking'
    | 'stored'
    | 'memory-only'
    | 'missing'
    | 'recovery-required'
    | 'unavailable';

export type LmsAuthenticationStatus =
    | 'not-applicable'
    | 'checking'
    | 'authenticated'
    | 'required'
    | 'unavailable';

export interface DashboardAccountStatus {
    serverSession: ServerSessionStatus;
    lmsAuthentication: LmsAuthenticationStatus;
}

interface AccountQueryState {
    data: DesktopConnectionState | undefined;
    isPending: boolean;
    isError: boolean;
}

export function dashboardAccountStatus(
    surface: DashboardSurfaceKind,
    query: AccountQueryState,
): DashboardAccountStatus {
    if (surface !== 'desktop') {
        return {
            serverSession: 'not-applicable',
            lmsAuthentication: 'not-applicable',
        };
    }
    if (!query.data) {
        const unavailable = query.isError && !query.isPending;
        return {
            serverSession: unavailable ? 'unavailable' : 'checking',
            lmsAuthentication: unavailable ? 'unavailable' : 'checking',
        };
    }

    const serverSession: ServerSessionStatus = query.data.state === 'reset-required'
        ? 'recovery-required'
        : query.data.state === 'connected'
            ? (query.data.credentialPersistent ? 'stored' : 'memory-only')
            : query.data.state === 'disconnected'
                ? 'missing'
                : 'checking';
    const lmsAuthentication: LmsAuthenticationStatus = query.data.lmsSessionState === 'connected'
        ? 'authenticated'
        : query.data.lmsSessionState === 'login-required'
            ? 'required'
            : 'checking';

    return {serverSession, lmsAuthentication};
}

export function assertLmsAuthenticated(status: DashboardAccountStatus): void {
    if (status.lmsAuthentication !== 'authenticated') {
        throw new Error('LMS_AUTH_REQUIRED');
    }
}

export function serverSessionReady(status: DashboardAccountStatus): boolean {
    return status.serverSession === 'stored' || status.serverSession === 'memory-only';
}

export function assertServerSessionReady(status: DashboardAccountStatus): void {
    if (!serverSessionReady(status)) {
        throw new Error('SERVER_SESSION_REQUIRED');
    }
}

export function normalizeLmsSessionStateEvent(
    value: unknown,
): DesktopConnectionState['lmsSessionState'] | null {
    return value === 'unknown' || value === 'connected' || value === 'login-required'
        ? value
        : null;
}

export function withLmsSessionState(
    current: DesktopConnectionState | undefined,
    lmsSessionState: DesktopConnectionState['lmsSessionState'],
): DesktopConnectionState | undefined {
    return current ? {...current, lmsSessionState} : undefined;
}

interface DashboardAccountContextValue {
    status: DashboardAccountStatus;
    connectionQuery: UseQueryResult<DesktopConnectionState, Error>;
}

const DashboardAccountContext = createContext<DashboardAccountContextValue | null>(null);

export function DashboardAccountProvider({children}: PropsWithChildren) {
    const {api, surface} = useDashboardEnvironment();
    const connectionQuery = useQuery({
        queryKey: queryKeys.desktopConnection,
        queryFn: () => api.getDesktopConnectionState(),
        enabled: surface.kind === 'desktop',
        staleTime: 60_000,
        refetchInterval: 60_000,
    });
    const status = dashboardAccountStatus(surface.kind, connectionQuery);
    const value = useMemo<DashboardAccountContextValue>(
        () => ({status, connectionQuery}),
        [connectionQuery, status],
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
