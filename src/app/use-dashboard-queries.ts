import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import type {DashboardNotification} from '@/api/dashboard-api';
import type {NotificationInboxSnapshot} from '@/domain/notifications/inbox';
import {
    laundryQueryContract,
    laundryQueryOptions,
    mealsQueryContract,
    mealsQueryOptions,
} from './campus-query-options';
import {assertLmsAuthenticated, serverSessionReady, useDashboardAccount} from './dashboard-account';
import {queryKeys, useDashboardEnvironment} from './dashboard-context';
import {runAttendanceRefresh, runDashboardRefresh} from './dashboard-refresh';

export const DASHBOARD_REFRESH = {
    personal: 60_000,
} as const;

export function useLaundryQuery() {
    const {api} = useDashboardEnvironment();
    return useQuery(laundryQueryOptions(api));
}

export function useMealsQuery() {
    const {api} = useDashboardEnvironment();
    return useQuery(mealsQueryOptions(api));
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
    const {api, surface} = useDashboardEnvironment();
    const account = useDashboardAccount();
    const personalSurface = surface.kind === 'desktop' ? 'desktop' : 'companion';
    const lmsReady = surface.kind !== 'desktop'
        || account.status.lmsAuthentication === 'authenticated';
    const sessionReady = surface.kind !== 'desktop' || serverSessionReady(account.status);
    return useQuery({
        queryKey: queryKeys.attendance(personalSurface),
        queryFn: () => api.getAttendance(personalSurface),
        enabled: surface.canViewAttendance && lmsReady && sessionReady,
        staleTime: DASHBOARD_REFRESH.personal,
        refetchInterval: DASHBOARD_REFRESH.personal,
    });
}

export function useDesktopConnectionQuery() {
    return useDashboardAccount().connectionQuery;
}

export function useRefreshAttendanceMutation() {
    const {api, surface} = useDashboardEnvironment();
    const account = useDashboardAccount();
    const client = useQueryClient();
    const attendanceSurface = surface.kind === 'desktop' ? 'desktop' : 'companion';
    return useMutation({
        mutationKey: ['attendance', 'manual-refresh'],
        mutationFn: () => {
            if (surface.kind === 'desktop') assertLmsAuthenticated(account.status);
            const desktopSessionReady = surface.kind !== 'desktop' || serverSessionReady(account.status);
            return runAttendanceRefresh({
                refreshPlatform: surface.kind === 'desktop' ? async () => {
                    try {
                        await api.refreshPlatformSync();
                    } finally {
                        await client.invalidateQueries({queryKey: queryKeys.desktopConnection, exact: true});
                    }
                } : undefined,
                refreshAttendance: desktopSessionReady
                    ? () => client.refetchQueries(
                        {queryKey: queryKeys.attendance(attendanceSurface), type: 'active'},
                        {throwOnError: true},
                    )
                    : async () => undefined,
            });
        },
    });
}

export function useNotificationsQuery() {
    const {api, surface} = useDashboardEnvironment();
    const personalSurface = surface.kind === 'desktop' ? 'desktop' : 'companion';
    return useQuery<DashboardNotification[] | NotificationInboxSnapshot>({
        queryKey: queryKeys.notifications(personalSurface),
        queryFn: () => surface.kind === 'desktop'
            ? api.getDesktopNotificationInbox()
            : api.getNotifications(),
        enabled: surface.canReceivePersonalNotifications,
        staleTime: DASHBOARD_REFRESH.personal,
        refetchInterval: DASHBOARD_REFRESH.personal,
    });
}

export function useRefreshHomeMutation() {
    const {api, surface} = useDashboardEnvironment();
    const account = useDashboardAccount();
    const client = useQueryClient();
    const attendanceSurface = surface.kind === 'desktop' ? 'desktop' : 'companion';
    const refreshDesktopPlatform = surface.kind === 'desktop'
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
            refreshAttendance: surface.canViewAttendance && (surface.kind !== 'desktop' || refreshDesktopAttendance)
                ? () => client.refetchQueries(
                    {queryKey: queryKeys.attendance(attendanceSurface), type: 'active'},
                    {throwOnError: true},
                )
                : undefined,
        }),
    });
}

export function useRefreshAllMutation() {
    const {api, surface} = useDashboardEnvironment();
    const account = useDashboardAccount();
    const client = useQueryClient();
    const attendanceSurface = surface.kind === 'desktop' ? 'desktop' : 'companion';
    const refreshDesktopPlatform = surface.kind === 'desktop'
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
                refreshAttendance: surface.canViewAttendance && (surface.kind !== 'desktop' || refreshDesktopAttendance)
                    ? () => client.invalidateQueries({queryKey: queryKeys.attendance(attendanceSurface)})
                    : undefined,
            });
        },
    });
}
