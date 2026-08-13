export type DashboardRoute =
    | 'home'
    | 'attendance'
    | 'laundry'
    | 'meals'
    | 'notifications'
    | 'connections';

export interface DashboardRouteMeta {
    label: string;
    shortLabel: string;
}

export const DASHBOARD_ROUTE_META: Readonly<Record<DashboardRoute, DashboardRouteMeta>> = {
    home: {label: '홈', shortLabel: '홈'},
    attendance: {label: '출석', shortLabel: '출석'},
    laundry: {label: '세탁실', shortLabel: '세탁'},
    meals: {label: '식단', shortLabel: '식단'},
    notifications: {label: '알림', shortLabel: '알림'},
    connections: {label: '설정', shortLabel: '설정'},
};

const NAVIGATION_ROUTES = [
    'home',
    'attendance',
    'laundry',
    'meals',
] as const satisfies readonly DashboardRoute[];

const PERSONAL_UTILITY_ROUTES = [
    'notifications',
    'connections',
] as const satisfies readonly DashboardRoute[];

/**
 * Primary navigation stays limited to campus tasks. Notification and device
 * management routes are exposed separately through dashboardUtilityRoutes.
 */
export function dashboardNavigationRoutes(): readonly DashboardRoute[] {
    return NAVIGATION_ROUTES;
}

export function dashboardUtilityRoutes(): readonly DashboardRoute[] {
    return PERSONAL_UTILITY_ROUTES;
}

export function dashboardRouteHref(route: DashboardRoute): `#${DashboardRoute}` {
    return `#${route}`;
}

export function dashboardRouteFromHash(hash: string): DashboardRoute {
    const value = hash.trim().toLowerCase().replace(/^#/, '');
    return [...NAVIGATION_ROUTES, ...PERSONAL_UTILITY_ROUTES].includes(value as DashboardRoute)
        ? value as DashboardRoute
        : 'home';
}
