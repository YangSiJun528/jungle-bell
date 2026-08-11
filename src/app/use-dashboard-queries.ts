import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import type {DashboardNotification} from '@/api/dashboard-api';
import type {NotificationInboxSnapshot} from '@/domain/notifications/inbox';
import type {CampusDataKind} from './campus-data-health';
import {
    laundryQueryContract,
    laundryQueryOptions,
    mealsQueryContract,
    mealsQueryOptions,
} from './campus-query-options';
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

export function useCampusManualRefresh(kind: CampusDataKind) {
    const {api, runtime} = useDashboardEnvironment();
    const client = useQueryClient();
    const queryKey = kind === 'laundry'
        ? laundryQueryContract.queryKey
        : mealsQueryContract.queryKey;
    return useMutation({
        mutationKey: ['campus', 'manual-refresh', kind],
        mutationFn: async () => {
            if (runtime.runningInTauri) {
                await api.refreshCampusData(kind);
                return;
            }
            await client.refetchQueries(
                {queryKey, type: 'active'},
                {throwOnError: true},
            );
        },
    });
}

export function useAttendanceQuery() {
    const {api, surface} = useDashboardEnvironment();
    const personalSurface = surface.kind === 'desktop' ? 'desktop' : 'companion';
    return useQuery({
        queryKey: queryKeys.attendance(personalSurface),
        queryFn: () => api.getAttendance(personalSurface),
        enabled: surface.canViewAttendance,
        staleTime: DASHBOARD_REFRESH.personal,
        refetchInterval: DASHBOARD_REFRESH.personal,
    });
}

export function useRefreshAttendanceMutation() {
    const {api, surface} = useDashboardEnvironment();
    const client = useQueryClient();
    const attendanceSurface = surface.kind === 'desktop' ? 'desktop' : 'companion';
    return useMutation({
        mutationKey: ['attendance', 'manual-refresh'],
        mutationFn: () => runAttendanceRefresh({
            refreshPlatform: surface.kind === 'desktop' ? () => api.refreshPlatformSync() : undefined,
            refreshAttendance: () => client.refetchQueries(
                {queryKey: queryKeys.attendance(attendanceSurface), type: 'active'},
                {throwOnError: true},
            ),
            refreshHomeOverview: surface.kind === 'desktop'
                ? () => client.refetchQueries(
                    {queryKey: queryKeys.homeOverview, type: 'active'},
                    {throwOnError: true},
                )
                : undefined,
        }),
    });
}

export function useHomeOverviewQuery() {
    const {api, surface} = useDashboardEnvironment();
    return useQuery({
        queryKey: queryKeys.homeOverview,
        queryFn: () => api.getDashboardHomeOverview(),
        enabled: surface.kind === 'desktop',
        staleTime: DASHBOARD_REFRESH.personal,
        refetchInterval: DASHBOARD_REFRESH.personal,
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
    const {api, runtime, surface} = useDashboardEnvironment();
    const client = useQueryClient();
    const attendanceSurface = surface.kind === 'desktop' ? 'desktop' : 'companion';
    return useMutation({
        mutationKey: ['home', 'manual-refresh'],
        mutationFn: async () => {
            if (runtime.runningInTauri) {
                await runDashboardRefresh({
                    refreshLaundry: () => api.refreshCampusData('laundry'),
                    refreshMeals: () => api.refreshCampusData('meals'),
                    refreshPlatform: () => api.refreshPlatformSync(),
                    refreshAttendance: surface.canViewAttendance
                        ? () => client.refetchQueries(
                        {queryKey: queryKeys.attendance(attendanceSurface), type: 'active'},
                        {throwOnError: true},
                        )
                        : undefined,
                    refreshHomeOverview: () => client.refetchQueries(
                        {queryKey: queryKeys.homeOverview, type: 'active'},
                        {throwOnError: true},
                    ),
                });
                return;
            }
            await runDashboardRefresh({
                refreshLaundry: () => client.refetchQueries(
                    {queryKey: laundryQueryContract.queryKey, type: 'active'},
                    {throwOnError: true},
                ),
                refreshMeals: () => client.refetchQueries(
                    {queryKey: mealsQueryContract.queryKey, type: 'active'},
                    {throwOnError: true},
                ),
                refreshAttendance: surface.canViewAttendance
                    ? () => client.refetchQueries(
                        {queryKey: queryKeys.attendance(attendanceSurface), type: 'active'},
                        {throwOnError: true},
                    )
                    : undefined,
            });
        },
    });
}

export function useRefreshAllMutation() {
    const {api, surface} = useDashboardEnvironment();
    const client = useQueryClient();
    const attendanceSurface = surface.kind === 'desktop' ? 'desktop' : 'companion';
    return useMutation({
        mutationFn: async () => {
            await runDashboardRefresh({
                refreshLaundry: () => client.invalidateQueries({queryKey: laundryQueryContract.queryKey}),
                refreshMeals: () => client.invalidateQueries({queryKey: mealsQueryContract.queryKey}),
                refreshPlatform: surface.kind === 'desktop' ? () => api.refreshPlatformSync() : undefined,
                refreshAttendance: surface.canViewAttendance
                    ? () => client.invalidateQueries({queryKey: queryKeys.attendance(attendanceSurface)})
                    : undefined,
                refreshHomeOverview: surface.kind === 'desktop'
                    ? () => client.invalidateQueries({queryKey: queryKeys.homeOverview})
                    : undefined,
            });
        },
    });
}
