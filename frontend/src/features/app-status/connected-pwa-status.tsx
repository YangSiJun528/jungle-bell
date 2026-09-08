import {useQuery} from '@tanstack/react-query';

import {
    loadPushSubscriptionReconciliation,
    PUSH_SUBSCRIPTION_LIFECYCLE_QUERY_KEY,
    type PushSubscriptionLifecycleStorage,
    type PushSubscriptionReconciliation,
} from '@/api/push-subscription-lifecycle';
import {useDashboardAccount} from '@/app/dashboard-account';
import {useDashboardEnvironment} from '@/app/dashboard-context';
import {
    NOTIFICATION_TEST_QUERY_KEY,
    readNotificationTestRecord,
    type NotificationTestRecord,
} from '@/platform/notification-test-history';

import packageMetadata from '../../../package.json';
import type {
    AppStatusTab,
    PwaAppStatusInput,
    PwaPushLifecycleObservation,
} from './app-status-model';
import {
    authenticationStateFromProducer,
    notificationPermissionFromRuntime,
    pushStateFromRuntime,
    serviceWorkerObservation,
} from './app-status-observations';
import {AppStatusPanel} from './app-status-panel';

function pushSubscriptionStorage(): PushSubscriptionLifecycleStorage {
    try {
        return window.localStorage;
    } catch (error) {
        throw new Error('PUSH_REGISTRATION_STORAGE_UNAVAILABLE', {cause: error});
    }
}

function pwaSessionExpiry(
    account: ReturnType<typeof useDashboardAccount>,
): PwaAppStatusInput['sessionExpiresAt'] {
    if (account.browserSessionQuery.data) return account.browserSessionQuery.data.expiresAt;
    if (account.personalAccess.status === 'checking') return 'checking';
    if (account.personalAccess.status === 'error') return 'unavailable';
    return account.personalAccess.status === 'unconnected' ? null : 'unavailable';
}

function lifecycleObservation(input: {
    data: PushSubscriptionReconciliation | undefined;
    isError: boolean;
    isPending: boolean;
}): PwaPushLifecycleObservation {
    if (input.isError) return {status: 'error'};
    if (!input.data) return {status: input.isPending ? 'checking' : 'error'};
    const metadata = 'metadata' in input.data ? input.data.metadata : undefined;
    const serverEvidence =
        input.data.status === 'matched-registered' ? input.data.serverEvidence : undefined;
    if (!metadata) return {status: input.data.status};
    return serverEvidence
        ? {status: input.data.status, subscriptionId: metadata.subscriptionId, serverEvidence}
        : {status: input.data.status, subscriptionId: metadata.subscriptionId};
}

function currentNotificationPermission() {
    return notificationPermissionFromRuntime(
        typeof Notification === 'undefined' ? undefined : Notification,
    );
}

export function ConnectedPwaStatus({onOpenTab}: {onOpenTab?: (tab: AppStatusTab) => void}) {
    const account = useDashboardAccount();
    const {platform} = useDashboardEnvironment();
    const pushLifecycle = useQuery({
        queryKey: PUSH_SUBSCRIPTION_LIFECYCLE_QUERY_KEY,
        queryFn: () =>
            loadPushSubscriptionReconciliation({
                storage: pushSubscriptionStorage(),
                getLocalSubscription: () => platform.pwa.getPushSubscription(),
            }),
        staleTime: 30_000,
    });
    const lastTest = useQuery({
        queryKey: NOTIFICATION_TEST_QUERY_KEY,
        queryFn: () => readNotificationTestRecord(pushSubscriptionStorage()),
        staleTime: Number.POSITIVE_INFINITY,
    });
    const worker = useQuery({
        queryKey: ['pwa-service-worker-status', packageMetadata.version],
        queryFn: async () =>
            serviceWorkerObservation(
                await platform.pwa.getServiceWorkerStatus(),
                packageMetadata.version,
            ),
        staleTime: 30_000,
        retry: false,
    });
    const permission = currentNotificationPermission();
    const lifecycle = lifecycleObservation(pushLifecycle);
    const restoredTest: NotificationTestRecord | null =
        lastTest.data?.surface === 'pwa' ? lastTest.data : null;
    const input: PwaAppStatusInput = {
        surface: 'pwa',
        authentication: authenticationStateFromProducer(account.personalAccess, {
            hasData: account.browserSessionQuery.data !== undefined,
            isError: account.browserSessionQuery.isError,
            isFetching: account.browserSessionQuery.isFetching,
            fetchStatus: account.browserSessionQuery.fetchStatus,
        }),
        sessionExpiresAt: pwaSessionExpiry(account),
        notificationPermission: permission,
        pushState: pushStateFromRuntime(permission, lifecycle, restoredTest),
        pushLifecycle: lifecycle,
        lastTest: lastTest.isPending ? 'checking' : lastTest.isError ? 'error' : restoredTest,
        serviceWorker: worker.isPending
            ? 'checking'
            : (worker.data ?? {status: 'error', version: packageMetadata.version}),
    };
    return <AppStatusPanel input={input} onOpenTab={onOpenTab} />;
}
