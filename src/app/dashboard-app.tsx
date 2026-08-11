import {lazy, Suspense, useEffect, useMemo, useState, useSyncExternalStore} from 'react';
import {LoadingState} from '@/components/dashboard/async-state';
import type {DashboardNotification} from '@/dashboard-api';
import type {DashboardRoute} from '@/dashboard-model';
import type {NotificationInboxSnapshot} from '@/notification-inbox';
import {useDashboardEnvironment} from './dashboard-context';
import {InstallPrompt, useInstallPromptVisibility} from './install-prompt';
import {DashboardShell} from './shell';
import {useHashRoute} from './use-hash-route';
import {useNotificationsQuery} from './use-dashboard-queries';
import {DASHBOARD_ROUTE_META} from './routes';
import {
    mergeSeenMobileNotificationIds,
    readSeenMobileNotificationIds,
    writeSeenMobileNotificationIds,
} from './mobile-notification-seen';
import {documentIsVisible, subscribeToDocumentVisibility} from './document-visibility';

const HomePage = lazy(() => import('@/features/home/home-page').then((module) => ({default: module.HomePage})));
const AttendancePage = lazy(() => import('@/features/attendance/attendance-page').then((module) => ({default: module.AttendancePage})));
const LaundryPage = lazy(() => import('@/features/laundry/pages/laundry-page').then((module) => ({default: module.LaundryPage})));
const MealsPage = lazy(() => import('@/features/meals/pages/meals-page').then((module) => ({default: module.MealsPage})));
const NotificationsPage = lazy(() => import('@/features/notifications/notifications-page').then((module) => ({default: module.NotificationsPage})));
const ConnectionsPage = lazy(() => import('@/features/connections/connections-page').then((module) => ({default: module.ConnectionsPage})));

function mobileNotificationIds(data: DashboardNotification[] | NotificationInboxSnapshot | undefined): string[] {
    return Array.isArray(data) ? data.map((notification) => notification.id) : [];
}

function RouteContent({
    route,
    onRequestInstall,
    seenMobileIds,
}: {
    route: DashboardRoute;
    onRequestInstall: () => void;
    seenMobileIds: ReadonlySet<string>;
}) {
    switch (route) {
        case 'attendance': return <AttendancePage/>;
        case 'laundry': return <LaundryPage/>;
        case 'meals': return <MealsPage/>;
        case 'notifications': return <NotificationsPage seenMobileIds={seenMobileIds}/>;
        case 'connections': return <ConnectionsPage/>;
        default: return <HomePage onRequestInstall={onRequestInstall}/>;
    }
}

export function DashboardApp() {
    const {surface} = useDashboardEnvironment();
    const {route, navigate} = useHashRoute(surface.kind);
    const notifications = useNotificationsQuery();
    const [seenMobileIds, setSeenMobileIds] = useState(readSeenMobileNotificationIds);
    const documentVisible = useSyncExternalStore(
        subscribeToDocumentVisibility,
        documentIsVisible,
        () => true,
    );
    const {installPromptOpen, openInstallPrompt, setInstallPromptVisibility} = useInstallPromptVisibility();

    useEffect(() => {
        document.title = `${DASHBOARD_ROUTE_META[route].label} · Jungle Bell`;
        window.scrollTo({top: 0, left: 0, behavior: 'auto'});
    }, [route]);

    useEffect(() => {
        if (surface.kind !== 'companion' || route !== 'notifications' || !documentVisible) return;
        const ids = mobileNotificationIds(notifications.data);
        if (ids.length === 0) return;
        const next = mergeSeenMobileNotificationIds(seenMobileIds, ids);
        if (next === seenMobileIds) return;
        writeSeenMobileNotificationIds(window.localStorage, next);
        setSeenMobileIds(next);
    }, [documentVisible, notifications.data, route, seenMobileIds, surface.kind]);

    const unreadCount = useMemo(() => {
        const data = notifications.data;
        if (!data) return 0;
        if (!Array.isArray(data)) return data.unreadCount;
        return data.filter((notification) => !seenMobileIds.has(notification.id)).length;
    }, [notifications.data, seenMobileIds]);

    return (
        <DashboardShell
            surface={surface.kind}
            activeRoute={route}
            navigate={navigate}
            unreadCount={unreadCount}
        >
            <Suspense fallback={<LoadingState label="화면을 준비하고 있습니다."/>}>
                <RouteContent
                    route={route}
                    onRequestInstall={openInstallPrompt}
                    seenMobileIds={seenMobileIds}
                />
            </Suspense>
            <InstallPrompt open={installPromptOpen} onOpenChange={setInstallPromptVisibility}/>
        </DashboardShell>
    );
}
