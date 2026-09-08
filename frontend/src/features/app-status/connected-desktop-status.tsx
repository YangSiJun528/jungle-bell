import {useQuery} from '@tanstack/react-query';

import {useDashboardAccount} from '@/app/dashboard-account';
import {serverSessionReady} from '@/app/dashboard-account-state';
import {queryKeys, useDashboardEnvironment} from '@/app/dashboard-context';
import {useDesktopUpdateQuery} from '@/app/desktop-update-query';
import {useAttendanceQuery} from '@/app/use-dashboard-queries';
import {
    NOTIFICATION_TEST_QUERY_KEY,
    readNotificationTestRecord,
    type NotificationTestRecord,
} from '@/platform/notification-test-history';

import type {AppStatusTab, DesktopAppStatusInput} from './app-status-model';
import {desktopUpdateObservationFromQuery} from './app-status-observations';
import {AppStatusPanel} from './app-status-panel';

function desktopLastSyncedAt(
    personalAccess: ReturnType<typeof useDashboardAccount>['personalAccess']['status'],
    attendance: ReturnType<typeof useAttendanceQuery>,
): DesktopAppStatusInput['lastSyncedAt'] {
    if (attendance.data?.state === 'loaded') {
        const value = attendance.data.attendance;
        if (value.status !== 'available') return value.lastSyncedAt;
        if (value.syncState === 'pending') {
            return {kind: 'pending', observedAt: value.lastSyncedAt};
        }
        return value.freshness === 'stale'
            ? {kind: 'stale', observedAt: value.lastSyncedAt}
            : value.lastSyncedAt;
    }
    if (personalAccess !== 'connected') return 'unavailable';
    if (attendance.isPending) return 'checking';
    if (attendance.isError) return 'unavailable';
    return null;
}

function useDesktopMobileSessions(personalReady: boolean) {
    const {api} = useDashboardEnvironment();
    return useQuery({
        queryKey: queryKeys.mobileSessions,
        queryFn: () => api.listMobileSessions(),
        enabled: personalReady,
        staleTime: 60_000,
        refetchInterval: 60_000,
    });
}

function desktopMobileSessionCount(
    personalReady: boolean,
    sessions: ReturnType<typeof useDesktopMobileSessions>,
): DesktopAppStatusInput['mobileSessionCount'] {
    if (sessions.data) return sessions.data.filter(({status}) => status === 'active').length;
    if (!personalReady) return 'unavailable';
    if (sessions.isPending) return 'checking';
    return 'unavailable';
}

function notificationTestStorage(): Storage {
    try {
        return window.localStorage;
    } catch (error) {
        throw new Error('NOTIFICATION_TEST_STORAGE_UNAVAILABLE', {cause: error});
    }
}

export function ConnectedDesktopStatus({onOpenTab}: {onOpenTab?: (tab: AppStatusTab) => void}) {
    const account = useDashboardAccount();
    const personalReady =
        account.status.lmsAuthentication === 'authenticated' && serverSessionReady(account.status);
    const attendance = useAttendanceQuery();
    const sessions = useDesktopMobileSessions(personalReady);
    const notificationTest = useQuery({
        queryKey: NOTIFICATION_TEST_QUERY_KEY,
        queryFn: () => readNotificationTestRecord(notificationTestStorage()),
        staleTime: Number.POSITIVE_INFINITY,
    });
    const {update} = useDesktopUpdateQuery();
    const restoredNotificationTest: NotificationTestRecord | null =
        notificationTest.data?.surface === 'pc' ? notificationTest.data : null;
    const input: DesktopAppStatusInput = {
        surface: 'desktop',
        lmsAuthentication: account.status.lmsAuthentication,
        serverSession: account.status.serverSession,
        lastSyncedAt: desktopLastSyncedAt(account.personalAccess.status, attendance),
        mobileSessionCount: desktopMobileSessionCount(personalReady, sessions),
        osNotification: notificationTest.isPending
            ? 'checking'
            : notificationTest.isError
              ? 'error'
              : restoredNotificationTest,
        update: desktopUpdateObservationFromQuery(update),
    };
    return <AppStatusPanel input={input} onOpenTab={onOpenTab} />;
}
