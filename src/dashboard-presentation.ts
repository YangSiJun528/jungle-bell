import type {DashboardRoute, DashboardSurfaceKind} from './dashboard-model';

export type DashboardSurfaceTone = 'neutral' | 'success' | 'warning';

export interface DashboardSurfaceBadgeState {
    desktopConnected?: boolean;
    companionAuthenticated?: boolean;
}

export interface DashboardSurfaceBadge {
    label: string;
    tone: DashboardSurfaceTone;
}

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
    'notifications',
    'connections',
] as const satisfies readonly DashboardRoute[];

const ROUTE_TITLES: Record<DashboardRoute, string> = {
    home: '오늘',
    attendance: '출석',
    laundry: '세탁',
    meals: '급식',
    notifications: '알림',
    connections: 'PC 연결',
};

export function dashboardNavigationRoutes(
    surfaceKind: DashboardSurfaceKind,
): readonly DashboardRoute[] {
    return surfaceKind === 'public'
        ? PUBLIC_NAVIGATION_ROUTES
        : PERSONAL_NAVIGATION_ROUTES;
}

export function dashboardRouteTitle(route: DashboardRoute): string {
    return ROUTE_TITLES[route];
}

export function dashboardSurfaceFooter(surfaceKind: DashboardSurfaceKind): string {
    return surfaceKind === 'public'
        ? '오늘의 공개 생활 정보'
        : '오늘의 출석 · 생활 정보 · 알림';
}

export function dashboardSurfaceBadge(
    surfaceKind: DashboardSurfaceKind,
    state: DashboardSurfaceBadgeState,
): DashboardSurfaceBadge {
    if (surfaceKind === 'desktop') {
        return state.desktopConnected === true
            ? {label: 'PC 연결됨', tone: 'success'}
            : {label: 'PC 앱', tone: 'warning'};
    }
    if (surfaceKind === 'companion') {
        return state.companionAuthenticated === true
            ? {label: '모바일 연결됨', tone: 'success'}
            : {label: '연결 필요', tone: 'warning'};
    }
    return {label: '공개 웹', tone: 'neutral'};
}
