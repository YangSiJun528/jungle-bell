import type {PersonalAccessState} from '@/app/dashboard-account-state';
import type {DesktopUpdateStatus, PwaServiceWorkerStatus} from '@/platform/contracts';
import type {AuthenticationState, PushState} from '@/platform/status-model';

export interface ProducerQueryObservation {
    fetchStatus: 'fetching' | 'idle' | 'paused';
    hasData: boolean;
    isError: boolean;
    isFetching: boolean;
}

export function authenticationStateFromProducer(
    personalAccess: PersonalAccessState,
    query?: ProducerQueryObservation,
): AuthenticationState {
    if (query?.fetchStatus === 'paused') return {status: 'offline'};
    if (query?.isError) return {status: 'server-error'};
    if (query?.hasData && query.isFetching) return {status: 'recovering'};

    switch (personalAccess.status) {
        case 'checking':
            return {status: personalAccess.reason === 'refreshing' ? 'recovering' : 'checking'};
        case 'connected':
            return {status: 'authenticated'};
        case 'unconnected':
            return {
                status:
                    personalAccess.reason === 'first-connect'
                        ? 'first-connect'
                        : personalAccess.reason === 'expired'
                          ? 'expired'
                          : 'recovering',
            };
        case 'error':
            return {status: personalAccess.reason};
        case 'not-applicable':
            return {status: 'first-connect'};
    }
    return {status: 'server-error'};
}

export type DesktopUpdateQueryStatus = 'checking' | 'error' | 'fresh' | 'stale' | 'unavailable';

export interface DesktopUpdateObservation {
    checkedAt: string | null;
    queryStatus: DesktopUpdateQueryStatus;
    state: DesktopUpdateStatus | null;
}

export function desktopUpdateObservationFromQuery(query: {
    data: DesktopUpdateStatus | undefined;
    dataUpdatedAt: number;
    isError: boolean;
    isPending: boolean;
    isStale: boolean;
}): DesktopUpdateObservation {
    const checkedAt = query.dataUpdatedAt > 0 ? new Date(query.dataUpdatedAt).toISOString() : null;
    if (query.data) {
        return {
            state: query.data,
            queryStatus: query.isError ? 'error' : query.isStale ? 'stale' : 'fresh',
            checkedAt,
        };
    }
    return {
        state: null,
        queryStatus: query.isError ? 'error' : query.isPending ? 'checking' : 'unavailable',
        checkedAt,
    };
}

export type AppNotificationPermission = NotificationPermission | 'unsupported';

export function notificationPermissionFromRuntime(
    notification: Pick<typeof Notification, 'permission'> | undefined,
): AppNotificationPermission {
    return notification?.permission ?? 'unsupported';
}

export type PushLifecycleRuntimeStatus =
    | 'checking'
    | 'error'
    | 'matched-registered'
    | 'matched-server-removed'
    | 'local-only'
    | 'record-only'
    | 'mismatch'
    | 'none'
    | 'invalid'
    | 'failed';

export function pushStateFromRuntime(
    permission: AppNotificationPermission,
    lifecycle: {status: PushLifecycleRuntimeStatus},
    lastTest: {state: PushState} | null,
): PushState {
    if (permission === 'unsupported') return {status: 'unsupported'};
    if (permission === 'denied') return {status: 'denied'};
    if (permission === 'default') return {status: 'permission-default'};
    if (lifecycle.status === 'matched-registered') {
        if (
            lastTest &&
            ['test-sending', 'arrived', 'not-arrived', 'error'].includes(lastTest.state.status)
        ) {
            return lastTest.state;
        }
        return {status: 'registered-server'};
    }
    if (lifecycle.status === 'matched-server-removed' || lifecycle.status === 'local-only') {
        return {status: 'subscribed-local'};
    }
    return {status: 'error'};
}

export type ServiceWorkerObservation =
    | {status: 'active'; version: string; scriptUrl: string}
    | {status: 'installing' | 'waiting'; version: string}
    | {status: 'missing'; version: string}
    | {status: 'error'; version: string};

export function serviceWorkerObservation(
    observation: PwaServiceWorkerStatus,
    version: string,
): ServiceWorkerObservation {
    return {...observation, version};
}
