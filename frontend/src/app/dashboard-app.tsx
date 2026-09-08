import {Outlet, useNavigate, useRouterState} from '@tanstack/react-router';
import {lazy, useCallback, useEffect, useMemo, useState} from 'react';

import {AsyncBoundary} from '@/components/dashboard/async-boundary';
import {InstallPrompt, useInstallPromptVisibility} from '@/platform/pwa/install-prompt';

import {useDashboardEnvironment} from './dashboard-context';
import {DashboardRouteAccessibility} from './dashboard-route-accessibility';
import {DashboardRouteErrorFallback} from './dashboard-route-error';
import {DashboardRouteRuntimeProvider} from './dashboard-route-runtime';
import {DesktopLifecycleSummary} from './desktop-lifecycle-controller';
import {DesktopUpdateNotice} from './desktop-update-notice';
import {
    mergeSeenMobileNotificationIds,
    readSeenMobileNotificationIds,
    writeSeenMobileNotificationIds,
} from './mobile-notification-seen';
import {NotificationOnboardingNotice} from './notification-onboarding-notice';
import {
    notificationPanelBackgroundRoute,
    type DashboardContentRoute,
} from './notification-panel-route';
import {PlatformAuthenticationGate} from './platform-authentication-gate';
import {PublicRouteOutlet} from './privacy-page';
import {
    dashboardRouteFromPath,
    dashboardRoutePath,
    isPersonalDashboardRoute,
    type DashboardRoute,
} from './routes';
import {DashboardShell} from './shell';
import {useNotificationsQuery} from './use-dashboard-queries';

const NotificationPanelContent = lazy(() =>
    import('@/features/notifications/notifications-page').then((module) => ({
        default: module.NotificationPanelContent,
    })),
);
export function DashboardApp() {
    const pathname = useRouterState({select: (state) => state.location.pathname});
    return (
        <>
            <DashboardRouteAccessibility pathname={pathname} />
            {pathname === '/privacy' ? <PublicRouteOutlet /> : <DashboardContent />}
        </>
    );
}

function DashboardContent() {
    const {platform} = useDashboardEnvironment();
    const pathname = useRouterState({select: (state) => state.location.pathname});
    const routerNavigate = useNavigate();
    const route = dashboardRouteFromPath(pathname);
    const notifications = useNotificationsQuery();
    const [seenMobileIds, setSeenMobileIds] = useState(readSeenMobileNotificationIds);
    const [notificationPanelRequestedOpen, setNotificationPanelRequestedOpen] = useState(false);
    const [notificationBackgroundRoute, setNotificationBackgroundRoute] =
        useState<DashboardContentRoute>(() => notificationPanelBackgroundRoute('home', route));
    const [renderedRoute, setRenderedRoute] = useState(route);
    const {installPromptOpen, openInstallPrompt, setInstallPromptVisibility} =
        useInstallPromptVisibility();

    if (renderedRoute !== route) {
        setRenderedRoute(route);
        if (route !== 'notifications') {
            setNotificationBackgroundRoute(route);
            setNotificationPanelRequestedOpen(false);
        }
    }

    const contentRoute = notificationPanelBackgroundRoute(notificationBackgroundRoute, route);
    const notificationPanelOpen = route === 'notifications' || notificationPanelRequestedOpen;

    const navigate = useCallback(
        (next: DashboardRoute, replace = false) => {
            if (next === route && !replace) {
                window.scrollTo({top: 0, behavior: 'smooth'});
                return;
            }
            void routerNavigate({
                to: dashboardRoutePath(next),
                replace,
            });
        },
        [route, routerNavigate],
    );

    useEffect(() => {
        if (route === 'notifications') return;
        window.scrollTo({top: 0, left: 0, behavior: 'auto'});
    }, [route]);

    const markMobileNotificationsSeen = useCallback((ids: readonly string[]) => {
        setSeenMobileIds((current) => {
            const next = mergeSeenMobileNotificationIds(current, ids);
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
            notificationPanel={{
                open: notificationPanelOpen,
                onOpenChange: (open) => {
                    setNotificationPanelRequestedOpen(open);
                    if (!open && route === 'notifications') navigate(contentRoute, true);
                },
                content: (
                    <PlatformAuthenticationGate enabled>
                        <AsyncBoundary
                            errorTitle="알림함을 불러오지 못했습니다."
                            resetKeys={[notificationPanelOpen]}
                        >
                            <NotificationPanelContent
                                seenMobileIds={seenMobileIds}
                                onMobileNotificationsSeen={markMobileNotificationsSeen}
                            />
                        </AsyncBoundary>
                    </PlatformAuthenticationGate>
                ),
            }}
        >
            <DesktopUpdateNotice />
            <NotificationOnboardingNotice />
            <DashboardRouteRuntimeProvider value={{contentRoute, openInstallPrompt}}>
                <AsyncBoundary
                    resetKeys={[contentRoute]}
                    renderError={({retry}) => (
                        <DashboardRouteErrorFallback route={contentRoute} retry={retry} />
                    )}
                >
                    <PlatformAuthenticationGate
                        enabled={isPersonalDashboardRoute(contentRoute)}
                        preserveRouteHeading
                    >
                        <Outlet />
                    </PlatformAuthenticationGate>
                </AsyncBoundary>
                {platform.kind === 'desktop' && contentRoute === 'connections' ? (
                    <div className="mt-6">
                        <DesktopLifecycleSummary />
                    </div>
                ) : null}
            </DashboardRouteRuntimeProvider>
            <InstallPrompt open={installPromptOpen} onOpenChange={setInstallPromptVisibility} />
        </DashboardShell>
    );
}
