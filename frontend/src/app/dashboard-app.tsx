import {lazy, useCallback, useEffect, useMemo, useState} from 'react';
import {AsyncBoundary} from '@/components/dashboard/async-boundary';
import {useDashboardEnvironment} from './dashboard-context';
import {InstallPrompt, useInstallPromptVisibility} from '@/platform/pwa/install-prompt';
import {DashboardShell} from './shell';
import {useHashRoute} from './use-hash-route';
import {useNotificationsQuery} from './use-dashboard-queries';
import {DASHBOARD_ROUTE_META} from './routes';
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

const HomePage = lazy(() => import('@/features/home/home-page').then((module) => ({default: module.HomePage})));
const AttendancePage = lazy(() => import('@/features/attendance/attendance-page').then((module) => ({default: module.AttendancePage})));
const LaundryPage = lazy(() => import('@/features/laundry/pages/laundry-page').then((module) => ({default: module.LaundryPage})));
const MealsPage = lazy(() => import('@/features/meals/pages/meals-page').then((module) => ({default: module.MealsPage})));
const NotificationPanelContent = lazy(() => import('@/features/notifications/notifications-page').then((module) => ({default: module.NotificationPanelContent})));
const ConnectionsPage = lazy(() => import('@/features/connections/connections-page').then((module) => ({default: module.ConnectionsPage})));

function RouteContent({
    route,
    onRequestInstall,
}: {
    route: DashboardContentRoute;
    onRequestInstall: () => void;
}) {
    switch (route) {
        case 'attendance': return <AttendancePage/>;
        case 'laundry': return <LaundryPage/>;
        case 'meals': return <MealsPage/>;
        case 'connections': return <ConnectionsPage/>;
        default: return <HomePage onRequestInstall={onRequestInstall}/>;
    }
}

export function DashboardApp() {
    const {platform} = useDashboardEnvironment();
    const {route, navigate, replace} = useHashRoute();
    const notifications = useNotificationsQuery();
    const [seenMobileIds, setSeenMobileIds] = useState(readSeenMobileNotificationIds);
    const [notificationPanelRequestedOpen, setNotificationPanelRequestedOpen] = useState(false);
    const [notificationBackgroundRoute, setNotificationBackgroundRoute] = useState<DashboardContentRoute>(
        () => notificationPanelBackgroundRoute('home', route),
    );
    const {installPromptOpen, openInstallPrompt, setInstallPromptVisibility} = useInstallPromptVisibility();
    const contentRoute = notificationPanelBackgroundRoute(notificationBackgroundRoute, route);
    const notificationPanelOpen = route === 'notifications' || notificationPanelRequestedOpen;

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
                    if (!open && route === 'notifications') replace(contentRoute);
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
            <AsyncBoundary resetKeys={[contentRoute]}>
                <RouteContent
                    route={contentRoute}
                    onRequestInstall={openInstallPrompt}
                />
            </AsyncBoundary>
            <InstallPrompt open={installPromptOpen} onOpenChange={setInstallPromptVisibility}/>
        </DashboardShell>
    );
}
