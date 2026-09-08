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

export type PersonalAccessState =
    | {status: 'not-applicable'; reason: 'not-applicable'}
    | {
          status: 'checking';
          reason: 'initial-check' | 'refreshing';
          lastSuccessfulSessionExpiresAt?: string;
      }
    | {status: 'connected'; reason: 'authenticated'; expiresAt?: string}
    | {
          status: 'unconnected';
          reason: 'expired' | 'first-connect' | 'recovery-required';
          expiredAt?: string;
      }
    | {
          status: 'error';
          reason: 'offline' | 'server-error';
          retryable: true;
          lastSuccessfulSessionExpiresAt?: string;
      };

export interface CookieSessionEvidence {
    readonly expiresAt: string;
    readonly lastConfirmedAtEpochMs: number;
}

export type CookieSessionObservation =
    | {kind: 'checking'}
    | {kind: 'authenticated'; expiresAt: string}
    | {kind: 'missing'}
    | {kind: 'failed'; reason: 'offline' | 'server-error'};

export interface CookieSessionAccessTransition {
    state: PersonalAccessState;
    evidence: CookieSessionEvidence | null;
}

export const CHECKER_LMS_UNKNOWN_TIMEOUT_MS = 10_000;

export interface CheckerWaitState {
    attempt: number;
    timedOut: boolean;
}

export type CheckerWaitAction =
    | {type: 'timeout'; attempt: number}
    | {type: 'retry'}
    | {type: 'resolved'};

export const initialCheckerWaitState: CheckerWaitState = {attempt: 0, timedOut: false};

export function checkerWaitTransition(
    state: CheckerWaitState,
    action: CheckerWaitAction,
): CheckerWaitState {
    switch (action.type) {
        case 'timeout':
            return action.attempt === state.attempt ? {...state, timedOut: true} : state;
        case 'retry':
            return {attempt: state.attempt + 1, timedOut: false};
        case 'resolved':
            return state.timedOut ? {...state, timedOut: false} : state;
        default:
            return state;
    }
}

interface AccountQueryState {
    data: DesktopConnectionState | undefined;
    isPending: boolean;
    isError: boolean;
}

export interface BrowserSessionQueryState {
    data: BrowserAccountSession | null | undefined;
    isPending: boolean;
    isError: boolean;
    fetchStatus?: 'fetching' | 'idle' | 'paused';
}

export function browserSessionObservation(
    browser: BrowserSessionQueryState,
): CookieSessionObservation {
    if (browser.fetchStatus === 'paused') return {kind: 'failed', reason: 'offline'};
    if (browser.isError) return {kind: 'failed', reason: 'server-error'};
    if (browser.data === undefined) return {kind: 'checking'};
    if (browser.data === null) return {kind: 'missing'};
    return {kind: 'authenticated', expiresAt: browser.data.expiresAt};
}

/**
 * Reduces cookie-session observations without retaining a cookie, token, or user identifier.
 * The evidence is safe to keep in memory so a later missing response can be shown as expiry
 * instead of a first connection.
 */
export function transitionCookieSessionAccess(
    previousEvidence: CookieSessionEvidence | null,
    observation: CookieSessionObservation,
    nowEpochMs: number,
): CookieSessionAccessTransition {
    if (observation.kind === 'authenticated') {
        if (Date.parse(observation.expiresAt) <= nowEpochMs) {
            return {
                state: {
                    status: 'unconnected',
                    reason: 'expired',
                    expiredAt: observation.expiresAt,
                },
                evidence: previousEvidence,
            };
        }
        const evidence = {
            expiresAt: observation.expiresAt,
            lastConfirmedAtEpochMs: nowEpochMs,
        };
        return {
            state: {
                status: 'connected',
                reason: 'authenticated',
                expiresAt: observation.expiresAt,
            },
            evidence,
        };
    }
    if (observation.kind === 'checking') {
        return {
            state: previousEvidence
                ? {
                      status: 'checking',
                      reason: 'refreshing',
                      lastSuccessfulSessionExpiresAt: previousEvidence.expiresAt,
                  }
                : {status: 'checking', reason: 'initial-check'},
            evidence: previousEvidence,
        };
    }
    if (observation.kind === 'failed') {
        return {
            state: {
                status: 'error',
                reason: observation.reason,
                retryable: true,
                ...(previousEvidence
                    ? {lastSuccessfulSessionExpiresAt: previousEvidence.expiresAt}
                    : {}),
            },
            evidence: previousEvidence,
        };
    }
    return {
        state: previousEvidence
            ? {
                  status: 'unconnected',
                  reason: 'expired',
                  expiredAt: previousEvidence.expiresAt,
              }
            : {status: 'unconnected', reason: 'first-connect'},
        evidence: previousEvidence,
    };
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
    if (query.isError) {
        return {
            serverSession: 'unavailable',
            lmsAuthentication: 'unavailable',
        };
    }
    if (!query.data) {
        return {
            serverSession: 'checking',
            lmsAuthentication: 'checking',
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
    if (authentication === 'none') return {status: 'not-applicable', reason: 'not-applicable'};
    if (authentication === 'cookie') {
        const observation = browserSessionObservation(browser);
        if (observation.kind === 'authenticated') {
            return {
                status: 'connected',
                reason: 'authenticated',
                expiresAt: observation.expiresAt,
            };
        }
        if (observation.kind === 'missing') {
            return {status: 'unconnected', reason: 'first-connect'};
        }
        if (observation.kind === 'failed') {
            return {status: 'error', reason: observation.reason, retryable: true};
        }
        return {status: 'checking', reason: 'initial-check'};
    }
    if (desktop.lmsAuthentication === 'checking' || desktop.serverSession === 'checking') {
        return {status: 'checking', reason: 'initial-check'};
    }
    if (desktop.lmsAuthentication === 'unavailable' || desktop.serverSession === 'unavailable') {
        return {status: 'error', reason: 'server-error', retryable: true};
    }
    if (desktop.lmsAuthentication === 'authenticated' && serverSessionReady(desktop)) {
        return {status: 'connected', reason: 'authenticated'};
    }
    if (desktop.serverSession === 'recovery-required') {
        return {status: 'unconnected', reason: 'recovery-required'};
    }
    return {
        status: 'unconnected',
        reason: desktop.lmsAuthentication === 'required' ? 'expired' : 'first-connect',
    };
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
