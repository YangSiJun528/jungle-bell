import {useQuery, type UseQueryResult} from '@tanstack/react-query';
import {
    createContext,
    useContext,
    useEffect,
    useMemo,
    useState,
    type PropsWithChildren,
} from 'react';

import type {BrowserAccountSession, DesktopConnectionState} from '@/api/dashboard-api';

import {
    browserSessionObservation,
    dashboardAccountStatus,
    personalAccessState,
    transitionCookieSessionAccess,
    type CookieSessionEvidence,
    type DashboardAccountStatus,
    type PersonalAccessState,
} from './dashboard-account-state';
import {queryKeys, useDashboardEnvironment} from './dashboard-context';

interface DashboardAccountContextValue {
    status: DashboardAccountStatus;
    personalAccess: PersonalAccessState;
    connectionQuery: UseQueryResult<DesktopConnectionState>;
    browserSessionQuery: UseQueryResult<BrowserAccountSession | null>;
}

const DashboardAccountContext = createContext<DashboardAccountContextValue | null>(null);

interface DashboardAccountProviderProps extends PropsWithChildren {
    clock?: () => number;
}

const MAX_TIMEOUT_MILLISECONDS = 2_147_483_647;

function useSessionExpiryClock(expiresAt: string | undefined, clock: () => number): number {
    const [currentTime, setCurrentTime] = useState(clock);
    useEffect(() => {
        if (!expiresAt) return undefined;
        const expiresAtEpochMs = Date.parse(expiresAt);
        if (!Number.isFinite(expiresAtEpochMs) || currentTime >= expiresAtEpochMs) return undefined;
        const delay = Math.max(0, Math.min(expiresAtEpochMs - clock(), MAX_TIMEOUT_MILLISECONDS));
        const timeout = window.setTimeout(() => setCurrentTime(clock()), delay);
        return () => window.clearTimeout(timeout);
    }, [clock, currentTime, expiresAt]);
    return currentTime;
}

function sameCookieSessionEvidence(
    left: CookieSessionEvidence | null,
    right: CookieSessionEvidence | null,
): boolean {
    return (
        left === right ||
        (left?.expiresAt === right?.expiresAt &&
            left?.lastConfirmedAtEpochMs === right?.lastConfirmedAtEpochMs)
    );
}

export function DashboardAccountProvider({
    children,
    clock = Date.now,
}: DashboardAccountProviderProps) {
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
        enabled: platform.accountAuthentication.kind === 'cookie',
        staleTime: 60_000,
        refetchInterval: 60_000,
    });
    const [cookieSessionEvidence, setCookieSessionEvidence] =
        useState<CookieSessionEvidence | null>(null);
    const authentication = platform.accountAuthentication.kind;
    const currentTime = useSessionExpiryClock(browserSessionQuery.data?.expiresAt, clock);
    const browserSessionTransition = useMemo(() => {
        if (authentication !== 'cookie') return null;
        const observedAtEpochMs = Math.max(
            currentTime,
            browserSessionQuery.dataUpdatedAt ?? 0,
            browserSessionQuery.errorUpdatedAt ?? 0,
        );
        return transitionCookieSessionAccess(
            cookieSessionEvidence,
            browserSessionObservation(browserSessionQuery),
            observedAtEpochMs,
        );
    }, [authentication, browserSessionQuery, cookieSessionEvidence, currentTime]);
    const nextCookieSessionEvidence = browserSessionTransition?.evidence ?? null;
    if (!sameCookieSessionEvidence(cookieSessionEvidence, nextCookieSessionEvidence)) {
        setCookieSessionEvidence(nextCookieSessionEvidence);
    }
    const status = dashboardAccountStatus(platform.kind, connectionQuery);
    const personalAccess =
        browserSessionTransition?.state ??
        personalAccessState(authentication, status, browserSessionQuery);
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
