import {lazy, useCallback, useEffect, useMemo, useState} from 'react';
import {Outlet, useNavigate, useRouterState} from '@tanstack/react-router';
import {AsyncBoundary} from '@/components/dashboard/async-boundary';
import {useDashboardEnvironment} from './dashboard-context';
import {InstallPrompt, useInstallPromptVisibility} from '@/platform/pwa/install-prompt';
import {DashboardShell} from './shell';
import {useNotificationsQuery} from './use-dashboard-queries';
import {
    DASHBOARD_ROUTE_META,
    dashboardRouteFromPath,
    dashboardRoutePath,
    type DashboardRoute,
} from './routes';
import {DashboardAccountNotice} from './dashboard-account-notice';
import {
    mergeSeenMobileNotificationIds,
    readSeenMobileNotificationIds,
    writeSeenMobileNotificationIds,
} from './mobile-notification-seen';
import {
    notificationPanelBackgroundRoute,
    type DashboardContentRoute,
} from './notification-panel-route';
import {DashboardRouteRuntimeProvider} from './dashboard-route-runtime';

const NotificationPanelContent = lazy(() => import('@/features/notifications/notifications-page').then((module) => ({default: module.NotificationPanelContent})));

export function DashboardApp() {
    const {platform} = useDashboardEnvironment();
    const pathname = useRouterState({select: (state) => state.location.pathname});
    const routerNavigate = useNavigate();
    const route = dashboardRouteFromPath(pathname);
    const notifications = useNotificationsQuery();
    const [seenMobileIds, setSeenMobileIds] = useState(readSeenMobileNotificationIds);
    const [notificationPanelRequestedOpen, setNotificationPanelRequestedOpen] = useState(false);
    const [notificationBackgroundRoute, setNotificationBackgroundRoute] = useState<DashboardContentRoute>(
        () => notificationPanelBackgroundRoute('home', route),
    );
    const {installPromptOpen, openInstallPrompt, setInstallPromptVisibility} = useInstallPromptVisibility();
    const contentRoute = notificationPanelBackgroundRoute(notificationBackgroundRoute, route);
    const notificationPanelOpen = route === 'notifications' || notificationPanelRequestedOpen;

    const navigate = useCallback((next: DashboardRoute, replace = false) => {
        if (next === route && !replace) {
            window.scrollTo({top: 0, behavior: 'smooth'});
            return;
        }
        void routerNavigate({
            to: dashboardRoutePath(next),
            replace,
        });
    }, [route, routerNavigate]);

    useEffect(() => {
        document.title = `${DASHBOARD_ROUTE_META[route].label} · Jungle Bell`;
    }, [route]);

    useEffect(() => {
        window.scrollTo({top: 0, left: 0, behavior: 'auto'});
    }, [contentRoute]);

    useEffect(() => {
        if (route === 'notifications') return;
        setNotificationBackgroundRoute(route);
        setNotificationPanelRequestedOpen(false);
    }, [route]);

    const markMobileNotificationSeen = useCallback((id: string) => {
        setSeenMobileIds((current) => {
            const next = mergeSeenMobileNotificationIds(current, [id]);
            if (next !== current) writeSeenMobileNotificationIds(window.localStorage, next);
            return next;
        });
    }, []);

    const unreadCount = useMemo(() => {
        const data = notifications.data;
        if (!data) return 0;
        if (!Array.isArray(data)) return data.unreadCount;
        return data.filter((notification) => !seenMobileIds.has(notification.id)).length;
    }, [notifications.data, seenMobileIds]);

    return (
        <DashboardShell
            platform={platform.kind}
            activeRoute={contentRoute}
            navigate={navigate}
            unreadCount={unreadCount}
            accountNotice={<DashboardAccountNotice/>}
            notificationPanel={{
                open: notificationPanelOpen,
                onOpenChange: (open) => {
                    setNotificationPanelRequestedOpen(open);
                    if (!open && route === 'notifications') navigate(contentRoute, true);
                },
                content: (
                    <AsyncBoundary
                        errorTitle="알림함을 불러오지 못했습니다."
                        resetKeys={[notificationPanelOpen]}
                    >
                        <NotificationPanelContent
                            seenMobileIds={seenMobileIds}
                            onMobileNotificationSeen={markMobileNotificationSeen}
                        />
                    </AsyncBoundary>
                ),
            }}
        >
            <DashboardRouteRuntimeProvider value={{contentRoute, openInstallPrompt}}>
                <AsyncBoundary resetKeys={[contentRoute]}>
                    <Outlet/>
                </AsyncBoundary>
            </DashboardRouteRuntimeProvider>
            <InstallPrompt open={installPromptOpen} onOpenChange={setInstallPromptVisibility}/>
        </DashboardShell>
    );
}
