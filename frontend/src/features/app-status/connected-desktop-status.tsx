import {useQuery} from '@tanstack/react-query';
import {CircleAlert, RefreshCw} from 'lucide-react';

import {useDashboardAccount} from '@/app/dashboard-account';
import {serverSessionReady} from '@/app/dashboard-account-state';
import {queryKeys, useDashboardEnvironment} from '@/app/dashboard-context';
import {useDesktopUpdateQuery} from '@/app/desktop-update-query';
import {useAttendanceQuery} from '@/app/use-dashboard-queries';
import {Alert, AlertDescription, AlertTitle} from '@/components/ui/alert';
import {Button} from '@/components/ui/button';
import {
    NOTIFICATION_TEST_QUERY_KEY,
    readNotificationTestRecord,
    type NotificationTestRecord,
} from '@/platform/notification-test-history';

import type {AppStatusTab, DesktopAppStatusInput} from './app-status-model';
import {appStatusRows} from './app-status-model';
import {desktopUpdateObservationFromQuery} from './app-status-observations';
import {AppStatusPanel} from './app-status-panel';
import type {AppStatusRenderer} from './app-status-render';
import {
    desktopLastSyncedAt,
    desktopMobileSessionCount,
    desktopStatusWarningCount,
    failedDesktopStatusProducers,
    retryFailedDesktopStatusProducers,
    type DesktopStatusProducer,
} from './connected-desktop-status-state';

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

function notificationTestStorage(): Storage {
    try {
        return window.localStorage;
    } catch (error) {
        throw new Error('NOTIFICATION_TEST_STORAGE_UNAVAILABLE', {cause: error});
    }
}

function DesktopStatusRefreshFailure({failures}: {failures: readonly DesktopStatusProducer[]}) {
    if (failures.length === 0) return null;

    const labels = failures.map(({label}) => label).join(', ');
    const cachedCount = failures.filter(({data}) => data !== undefined).length;
    const retrying = failures.some(({isFetching}) => isFetching);
    return (
        <Alert variant="destructive">
            <CircleAlert aria-hidden="true" />
            <AlertTitle>일부 앱 상태를 다시 확인하지 못했습니다.</AlertTitle>
            <AlertDescription>
                <p>
                    {labels} 최신 상태를 확인하지 못했습니다.{' '}
                    {cachedCount > 0
                        ? '이전 확인값은 참고용으로만 유지하며 정상 상태로 판정하지 않습니다. '
                        : null}
                    네트워크를 확인한 뒤 다시 시도하세요.
                </p>
                <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={retrying}
                    onClick={() => void retryFailedDesktopStatusProducers(failures)}
                >
                    <RefreshCw
                        aria-hidden="true"
                        className={retrying ? 'animate-spin' : undefined}
                    />
                    {retrying ? '다시 확인 중' : '실패한 상태 다시 확인'}
                </Button>
            </AlertDescription>
        </Alert>
    );
}

export function ConnectedDesktopStatus({
    children,
    onOpenTab,
}: {
    children?: AppStatusRenderer;
    onOpenTab?: (tab: AppStatusTab) => void;
}) {
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
    const failures = failedDesktopStatusProducers([
        {
            label: 'PC 연결',
            rowIds: ['lms-authentication', 'server-credential'],
            data: account.connectionQuery.data,
            isError: account.connectionQuery.isError,
            isFetching: account.connectionQuery.isFetching,
            refetch: () => account.connectionQuery.refetch(),
        },
        {
            label: '출석 동기화',
            rowIds: ['last-sync'],
            data: attendance.data,
            isError: attendance.isError,
            isFetching: attendance.isFetching,
            refetch: () => attendance.refetch(),
        },
        {
            label: '모바일 세션',
            rowIds: ['mobile-sessions'],
            data: sessions.data,
            isError: sessions.isError,
            isFetching: sessions.isFetching,
            refetch: () => sessions.refetch(),
        },
        {
            label: '알림 테스트 기록',
            rowIds: ['os-notification'],
            data: notificationTest.data,
            isError: notificationTest.isError,
            isFetching: notificationTest.isFetching,
            refetch: () => notificationTest.refetch(),
        },
        {
            label: '앱 업데이트',
            rowIds: ['update'],
            data: update.data,
            isError: update.isError,
            isFetching: update.isFetching,
            refetch: () => update.refetch(),
        },
    ]);
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
    const content = (
        <div className="space-y-4">
            <DesktopStatusRefreshFailure failures={failures} />
            <AppStatusPanel input={input} onOpenTab={onOpenTab} />
        </div>
    );
    return children
        ? children({
              content,
              warningCount: desktopStatusWarningCount(appStatusRows(input), failures),
          })
        : content;
}
