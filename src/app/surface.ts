export type DashboardRoute =
    | 'home'
    | 'attendance'
    | 'laundry'
    | 'meals'
    | 'notifications'
    | 'connections';

export type DashboardSurfaceKind = 'public' | 'desktop' | 'companion';

export interface DashboardSurface {
    kind: DashboardSurfaceKind;
    canManageDesktop: boolean;
    canPairMobile: boolean;
    canReceivePersonalNotifications: boolean;
    canViewAttendance: boolean;
}

const DASHBOARD_ROUTES: readonly DashboardRoute[] = [
    'home',
    'attendance',
    'laundry',
    'meals',
    'notifications',
    'connections',
];

const DESKTOP_SURFACE: DashboardSurface = {
    kind: 'desktop',
    canManageDesktop: true,
    canPairMobile: true,
    canReceivePersonalNotifications: true,
    canViewAttendance: true,
};

const COMPANION_SURFACE: DashboardSurface = {
    kind: 'companion',
    canManageDesktop: false,
    canPairMobile: false,
    canReceivePersonalNotifications: true,
    canViewAttendance: true,
};

const PUBLIC_SURFACE: DashboardSurface = {
    kind: 'public',
    canManageDesktop: false,
    canPairMobile: false,
    canReceivePersonalNotifications: false,
    canViewAttendance: false,
};

export function dashboardRouteFromHash(hash: string): DashboardRoute {
    const value = hash.trim().toLowerCase().replace(/^#/, '');
    return DASHBOARD_ROUTES.includes(value as DashboardRoute)
        ? value as DashboardRoute
        : 'home';
}

export function dashboardRouteForSurface(
    hash: string,
    surfaceKind: DashboardSurfaceKind,
): DashboardRoute {
    const route = dashboardRouteFromHash(hash);
    if (surfaceKind === 'public' && route !== 'home' && route !== 'laundry' && route !== 'meals') return 'home';
    return route;
}

export function resolveDashboardSurface(input: {
    runningInTauri: boolean;
    standalone?: boolean;
}): DashboardSurface {
    if (input.runningInTauri) return DESKTOP_SURFACE;
    if (input.standalone) return COMPANION_SURFACE;
    return PUBLIC_SURFACE;
}

const COMPANION_AUTHENTICATION_ERRORS = new Set([
    'HTTP_401',
    'UNAUTHORIZED',
    'AUTHENTICATION_REQUIRED',
    'SESSION_EXPIRED',
    'MOBILE_SESSION_REQUIRED',
]);

export function companionAuthenticationRequired(error: unknown): boolean {
    return error instanceof Error && COMPANION_AUTHENTICATION_ERRORS.has(error.message);
}
