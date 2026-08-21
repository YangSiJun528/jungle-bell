export type DashboardRoute =
    | 'home'
    | 'attendance'
    | 'laundry'
    | 'meals'
    | 'notifications'
    | 'connections'
    | 'install';

export type DashboardRoutePath = `/${DashboardRoute}`;

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
    install: {label: '앱 설치 안내', shortLabel: '앱 안내'},
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

const SUPPORT_ROUTES = ['install'] as const satisfies readonly DashboardRoute[];

const ALL_ROUTES = [...NAVIGATION_ROUTES, ...PERSONAL_UTILITY_ROUTES, ...SUPPORT_ROUTES] as const;

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

export function dashboardRoutePath(route: DashboardRoute): DashboardRoutePath {
    return `/${route}`;
}

export function dashboardRouteHref(route: DashboardRoute): `#${DashboardRoutePath}` {
    return `#${dashboardRoutePath(route)}`;
}

export function dashboardRouteFromPath(pathname: string): DashboardRoute {
    const value = pathname
        .trim()
        .toLowerCase()
        .replace(/^\/+|\/+$/gu, '');
    return ALL_ROUTES.includes(value as DashboardRoute) ? (value as DashboardRoute) : 'home';
}

export function dashboardRouteFromHash(hash: string): DashboardRoute {
    return dashboardRouteFromPath(hash.trim().replace(/^#/u, ''));
}

export function normalizeLegacyDashboardHash(hash: string): `#${DashboardRoutePath}` | null {
    const value = hash.trim().toLowerCase().replace(/^#/u, '');
    if (value === 'setup' || value === '/setup') return '#/install';
    if (value.startsWith('/')) return null;
    const route = ALL_ROUTES.includes(value as DashboardRoute) ? (value as DashboardRoute) : null;
    return route ? dashboardRouteHref(route) : null;
}
