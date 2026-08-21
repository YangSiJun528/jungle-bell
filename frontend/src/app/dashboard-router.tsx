import {
    createHashHistory,
    createRootRoute,
    createRoute,
    createRouter,
    type RouterHistory,
} from '@tanstack/react-router';

import {DashboardApp} from './dashboard-app';
import {
    AppInstallRoutePage,
    AttendanceRoutePage,
    ConnectionsRoutePage,
    HomeRoutePage,
    LaundryRoutePage,
    MealsRoutePage,
    NotificationRoutePage,
} from './dashboard-route-pages';
import {PrivacyPage} from './privacy-page';

const rootRoute = createRootRoute({component: DashboardApp});
const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: HomeRoutePage,
});
const homeRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: 'home',
    component: HomeRoutePage,
});
const attendanceRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: 'attendance',
    component: AttendanceRoutePage,
});
const laundryRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: 'laundry',
    component: LaundryRoutePage,
});
const mealsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: 'meals',
    component: MealsRoutePage,
});
const notificationsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: 'notifications',
    component: NotificationRoutePage,
});
const connectionsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: 'connections',
    component: ConnectionsRoutePage,
});
const installRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: 'install',
    component: AppInstallRoutePage,
});
const privacyRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: 'privacy',
    component: PrivacyPage,
});
const fallbackRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '$',
    component: HomeRoutePage,
});
const routeTree = rootRoute.addChildren([
    indexRoute,
    homeRoute,
    attendanceRoute,
    laundryRoute,
    mealsRoute,
    notificationsRoute,
    connectionsRoute,
    installRoute,
    privacyRoute,
    fallbackRoute,
]);

function buildDashboardRouter(history: RouterHistory) {
    return createRouter({
        routeTree,
        history,
        defaultPreload: 'intent',
        scrollRestoration: true,
    });
}

export type DashboardRouter = ReturnType<typeof buildDashboardRouter>;

declare module '@tanstack/react-router' {
    interface Register {
        router: DashboardRouter;
    }
}

export function createDashboardRouter(
    history: RouterHistory = createHashHistory(),
): DashboardRouter {
    return buildDashboardRouter(history);
}
