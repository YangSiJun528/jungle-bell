import type {SearchSchemaInput} from '@tanstack/react-router';

export type DashboardRoute =
    | 'home'
    | 'attendance'
    | 'laundry'
    | 'meals'
    | 'notifications'
    | 'connections'
    | 'install';

export type DashboardRoutePath = `/${DashboardRoute}`;

export type DashboardRouteAccess = 'mixed' | 'personal' | 'public';

export const CONNECTIONS_TABS = ['notifications', 'services', 'devices'] as const;
export type ConnectionsTab = (typeof CONNECTIONS_TABS)[number];
export type DashboardReturnTarget = '/' | '/privacy' | Exclude<DashboardRoutePath, '/connections'>;

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

const ROUTE_ACCESS = {
    home: 'public',
    attendance: 'personal',
    laundry: 'public',
    meals: 'public',
    notifications: 'personal',
    connections: 'mixed',
    install: 'public',
} as const satisfies Readonly<Record<DashboardRoute, DashboardRouteAccess>>;

const DASHBOARD_RETURN_TARGETS = [
    '/',
    '/home',
    '/attendance',
    '/laundry',
    '/meals',
    '/notifications',
    '/install',
    '/privacy',
] as const satisfies readonly DashboardReturnTarget[];

export interface ConnectionsSearchInput {
    tab?: ConnectionsTab;
    returnTo?: DashboardReturnTarget;
}

export interface ConnectionsSearch {
    tab: ConnectionsTab;
    returnTo?: DashboardReturnTarget;
}

type ConnectionsSearchValidatorInput = ConnectionsSearchInput & SearchSchemaInput;

function isDashboardRoute(value: string): value is DashboardRoute {
    return ALL_ROUTES.some((route) => route === value);
}

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

export function dashboardRouteAccess(route: DashboardRoute): DashboardRouteAccess {
    return ROUTE_ACCESS[route];
}

export function isPublicDashboardRoute(route: DashboardRoute): boolean {
    return dashboardRouteAccess(route) === 'public';
}

export function isPersonalDashboardRoute(route: DashboardRoute): boolean {
    return dashboardRouteAccess(route) === 'personal';
}

export function isMixedDashboardRoute(route: DashboardRoute): boolean {
    return dashboardRouteAccess(route) === 'mixed';
}

export function normalizeDashboardReturnTarget(value: unknown): DashboardReturnTarget | undefined {
    return DASHBOARD_RETURN_TARGETS.find((candidate) => candidate === value);
}

export function normalizeConnectionsSearch(search: {
    tab?: unknown;
    returnTo?: unknown;
}): ConnectionsSearch {
    const tab = CONNECTIONS_TABS.find((candidate) => candidate === search.tab) ?? 'notifications';
    const returnTo = normalizeDashboardReturnTarget(search.returnTo);
    return returnTo ? {tab, returnTo} : {tab};
}

export function validateConnectionsSearch(
    search: ConnectionsSearchValidatorInput,
): ConnectionsSearch {
    return normalizeConnectionsSearch(search);
}

export function connectionsRouteSearch(
    tab: ConnectionsTab,
    returnTo?: DashboardReturnTarget,
): ConnectionsSearch {
    return returnTo ? {tab, returnTo} : {tab};
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
    return isDashboardRoute(value) ? value : 'home';
}

export function dashboardRouteFromHash(hash: string): DashboardRoute {
    return dashboardRouteFromPath(hash.trim().replace(/^#/u, ''));
}

export function normalizeLegacyDashboardHash(hash: string): `#${DashboardRoutePath}` | null {
    const value = hash.trim().toLowerCase().replace(/^#/u, '');
    if (value === 'setup' || value === '/setup') return '#/install';
    if (value.startsWith('/')) return null;
    const route = isDashboardRoute(value) ? value : null;
    return route ? dashboardRouteHref(route) : null;
}
