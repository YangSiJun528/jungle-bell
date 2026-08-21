import type {BrowserAccountSession, DesktopConnectionState} from '@/api/dashboard-api';
import type {AccountAuthentication, PlatformKind} from '@/platform/contracts';

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

export type PersonalAccessStatus =
    | 'not-applicable'
    | 'checking'
    | 'connected'
    | 'unconnected'
    | 'error';

export interface PersonalAccessState {
    status: PersonalAccessStatus;
}

interface AccountQueryState {
    data: DesktopConnectionState | undefined;
    isPending: boolean;
    isError: boolean;
}

interface BrowserSessionQueryState {
    data: BrowserAccountSession | null | undefined;
    isPending: boolean;
    isError: boolean;
}

export function dashboardAccountStatus(
    platform: PlatformKind,
    query: AccountQueryState,
): DashboardAccountStatus {
    if (platform !== 'desktop') {
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

    const serverSession: ServerSessionStatus =
        query.data.state === 'reset-required'
            ? 'recovery-required'
            : query.data.state === 'connected'
              ? query.data.credentialPersistent
                  ? 'stored'
                  : 'memory-only'
              : query.data.state === 'disconnected'
                ? 'missing'
                : 'checking';
    const lmsAuthentication: LmsAuthenticationStatus =
        query.data.lmsSessionState === 'connected'
            ? 'authenticated'
            : query.data.lmsSessionState === 'login-required'
              ? 'required'
              : 'checking';

    return {serverSession, lmsAuthentication};
}

export function personalAccessState(
    authentication: AccountAuthentication['kind'],
    desktop: DashboardAccountStatus,
    browser: BrowserSessionQueryState,
): PersonalAccessState {
    if (authentication === 'none') return {status: 'not-applicable'};
    if (authentication === 'cookie') {
        if (browser.data !== undefined) {
            return {status: browser.data ? 'connected' : 'unconnected'};
        }
        if (browser.isError) return {status: 'error'};
        return {status: 'checking'};
    }
    if (desktop.lmsAuthentication === 'checking' || desktop.serverSession === 'checking') {
        return {status: 'checking'};
    }
    if (desktop.lmsAuthentication === 'unavailable' || desktop.serverSession === 'unavailable') {
        return {status: 'error'};
    }
    return desktop.lmsAuthentication === 'authenticated' && serverSessionReady(desktop)
        ? {status: 'connected'}
        : {status: 'unconnected'};
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
