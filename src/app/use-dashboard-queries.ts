import {
    useMutation,
    useQuery,
    useQueryClient,
    useSuspenseQueries,
    useSuspenseQuery,
} from '@tanstack/react-query';
import type {DashboardNotification} from '@/api/dashboard-api';
import type {NotificationInboxSnapshot} from '@/domain/notifications/inbox';
import {
    laundryQueryContract,
    laundryQueryOptions,
    mealsQueryContract,
    mealsQueryOptions,
} from './campus-query-options';
import {useDashboardAccount} from './dashboard-account';
import {assertLmsAuthenticated, serverSessionReady} from './dashboard-account-state';
import {queryKeys, useDashboardEnvironment} from './dashboard-context';
import {runAttendanceRefresh, runDashboardRefresh} from './dashboard-refresh';

export const DASHBOARD_REFRESH = {
    personal: 60_000,
} as const;

export function useSuspenseLaundryQuery() {
    const {api} = useDashboardEnvironment();
    return useSuspenseQuery(laundryQueryOptions(api));
}

export function useSuspenseMealsQuery() {
    const {api} = useDashboardEnvironment();
    return useSuspenseQuery(mealsQueryOptions(api));
}

export function useSuspenseCampusQueries() {
    const {api} = useDashboardEnvironment();
    const [laundry, meals] = useSuspenseQueries({
        queries: [laundryQueryOptions(api), mealsQueryOptions(api)],
    });
    return {laundry, meals};
}

export function useCampusManualRefresh(kind: 'laundry' | 'meals') {
    const client = useQueryClient();
    const queryKey = kind === 'laundry'
        ? laundryQueryContract.queryKey
        : mealsQueryContract.queryKey;
    return useMutation({
        mutationKey: ['campus', 'manual-refresh', kind],
        mutationFn: () => client.refetchQueries(
            {queryKey, type: 'active'},
            {throwOnError: true},
        ),
    });
}

export function useAttendanceQuery() {
    const {api, platform} = useDashboardEnvironment();
    const account = useDashboardAccount();
    const lmsReady = !platform.capabilities.desktopAccount
        || account.status.lmsAuthentication === 'authenticated';
    const sessionReady = !platform.capabilities.desktopAccount || serverSessionReady(account.status);
    return useQuery({
        queryKey: queryKeys.attendance(platform.kind),
        queryFn: () => api.getAttendance(),
        enabled: lmsReady && sessionReady,
        staleTime: DASHBOARD_REFRESH.personal,
        refetchInterval: DASHBOARD_REFRESH.personal,
    });
}

export function useDesktopConnectionQuery() {
    return useDashboardAccount().connectionQuery;
}

export function useRefreshAttendanceMutation() {
    const {api, platform} = useDashboardEnvironment();
    const account = useDashboardAccount();
    const client = useQueryClient();
    return useMutation({
        mutationKey: ['attendance', 'manual-refresh'],
        mutationFn: () => {
            if (platform.capabilities.desktopAccount) assertLmsAuthenticated(account.status);
            const desktopSessionReady = !platform.capabilities.desktopAccount || serverSessionReady(account.status);
            return runAttendanceRefresh({
                refreshPlatform: platform.capabilities.desktopAccount ? async () => {
                    try {
                        await api.refreshPlatformSync();
                    } finally {
                        await client.invalidateQueries({queryKey: queryKeys.desktopConnection, exact: true});
                    }
                } : undefined,
                refreshAttendance: desktopSessionReady
                    ? () => client.refetchQueries(
                        {queryKey: queryKeys.attendance(platform.kind), type: 'active'},
                        {throwOnError: true},
                    )
                    : async () => undefined,
            });
        },
    });
}

export function useNotificationsQuery() {
    const {api, platform} = useDashboardEnvironment();
    return useQuery<DashboardNotification[] | NotificationInboxSnapshot>({
        queryKey: queryKeys.notifications(platform.kind),
        queryFn: () => platform.capabilities.localNotifications
            ? api.getDesktopNotificationInbox()
            : api.getNotifications(),
        staleTime: DASHBOARD_REFRESH.personal,
        refetchInterval: DASHBOARD_REFRESH.personal,
    });
}

export function useRefreshHomeMutation() {
    const {api, platform} = useDashboardEnvironment();
    const account = useDashboardAccount();
    const client = useQueryClient();
    const refreshDesktopPlatform = platform.capabilities.desktopAccount
        && account.status.lmsAuthentication === 'authenticated';
    const refreshDesktopAttendance = refreshDesktopPlatform && serverSessionReady(account.status);
    return useMutation({
        mutationKey: ['home', 'manual-refresh'],
        mutationFn: () => runDashboardRefresh({
            refreshLaundry: () => client.refetchQueries(
                {queryKey: laundryQueryContract.queryKey, type: 'active'},
                {throwOnError: true},
            ),
            refreshMeals: () => client.refetchQueries(
                {queryKey: mealsQueryContract.queryKey, type: 'active'},
                {throwOnError: true},
            ),
            refreshPlatform: refreshDesktopPlatform ? async () => {
                try {
                    await api.refreshPlatformSync();
                } finally {
                    await client.invalidateQueries({queryKey: queryKeys.desktopConnection, exact: true});
                }
            } : undefined,
            refreshAttendance: !platform.capabilities.desktopAccount || refreshDesktopAttendance
                ? () => client.refetchQueries(
                    {queryKey: queryKeys.attendance(platform.kind), type: 'active'},
                    {throwOnError: true},
                )
                : undefined,
        }),
    });
}

export function useRefreshAllMutation() {
    const {api, platform} = useDashboardEnvironment();
    const account = useDashboardAccount();
    const client = useQueryClient();
    const refreshDesktopPlatform = platform.capabilities.desktopAccount
        && account.status.lmsAuthentication === 'authenticated';
    const refreshDesktopAttendance = refreshDesktopPlatform && serverSessionReady(account.status);
    return useMutation({
        mutationFn: async () => {
            await runDashboardRefresh({
                refreshLaundry: () => client.invalidateQueries({queryKey: laundryQueryContract.queryKey}),
                refreshMeals: () => client.invalidateQueries({queryKey: mealsQueryContract.queryKey}),
                refreshPlatform: refreshDesktopPlatform ? async () => {
                    try {
                        await api.refreshPlatformSync();
                    } finally {
                        await client.invalidateQueries({queryKey: queryKeys.desktopConnection, exact: true});
                    }
                } : undefined,
                refreshAttendance: !platform.capabilities.desktopAccount || refreshDesktopAttendance
                    ? () => client.invalidateQueries({queryKey: queryKeys.attendance(platform.kind)})
                    : undefined,
            });
        },
    });
}
