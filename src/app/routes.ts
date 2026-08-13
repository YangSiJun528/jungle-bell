import type {DashboardRoute, DashboardSurfaceKind} from './surface';
import {dashboardRouteForSurface} from './surface';

export interface DashboardRouteMeta {
    label: string;
    shortLabel: string;
}

export type DashboardNavigationPlacement = 'sidebar' | 'bottom';

export const DASHBOARD_ROUTE_META: Readonly<Record<DashboardRoute, DashboardRouteMeta>> = {
    home: {label: '홈', shortLabel: '홈'},
    attendance: {label: '출석', shortLabel: '출석'},
    laundry: {label: '세탁실', shortLabel: '세탁'},
    meals: {label: '식단', shortLabel: '식단'},
    notifications: {label: '알림', shortLabel: '알림'},
    connections: {label: '설정', shortLabel: '설정'},
};

const PUBLIC_NAVIGATION_ROUTES = [
    'home',
    'laundry',
    'meals',
] as const satisfies readonly DashboardRoute[];

const PERSONAL_NAVIGATION_ROUTES = [
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
export function dashboardNavigationRoutes(
    surface: DashboardSurfaceKind,
    _placement: DashboardNavigationPlacement,
): readonly DashboardRoute[] {
    if (surface === 'public') return PUBLIC_NAVIGATION_ROUTES;
    return PERSONAL_NAVIGATION_ROUTES;
}

export function dashboardUtilityRoutes(
    surface: DashboardSurfaceKind,
): readonly DashboardRoute[] {
    return surface === 'public' ? [] : PERSONAL_UTILITY_ROUTES;
}

export function dashboardRouteHref(route: DashboardRoute): `#${DashboardRoute}` {
    return `#${route}`;
}

/** Resolves a hash through the surface-specific route allow-list. */
export function dashboardRouteFromHash(
    hash: string,
    surface: DashboardSurfaceKind,
): DashboardRoute {
    return dashboardRouteForSurface(hash, surface);
}
