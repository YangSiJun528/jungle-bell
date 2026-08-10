import type {LaundrySituationMachine} from './laundry-situation';
import type {LaundryStatusAppliance} from './laundry-status';

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

export interface DashboardLaundryMachine extends LaundrySituationMachine {
    id: string;
    zone: 'men' | 'common' | 'women' | 'other';
    washer: LaundryStatusAppliance | null;
    dryer: LaundryStatusAppliance | null;
}

export interface LaundryCapacityView {
    men: number | null;
    women: number | null;
}

export interface LaundryCapacityEstimate {
    access: 'men' | 'women';
    washerAvailable: number;
    projectedDryerSupply: number;
    pendingDryerLoads: number;
    dryerHeadroom: number;
    startableLoads: number | null;
    reliable: boolean;
}

export interface LaundryCapacitySnapshot {
    basis: 'WASHER_AND_DRYER_HEADROOM_60_MIN';
    men: LaundryCapacityEstimate;
    women: LaundryCapacityEstimate;
}

export interface AttendanceChecks {
    morningChecked: boolean;
    eveningChecked: boolean;
}

export type AttendanceHeadlineTone = 'success' | 'warning';

export const DASHBOARD_ROUTES: readonly DashboardRoute[] = [
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

/**
 * Crockford Base32 permits O/I/L as human input aliases for 0/1. U is not in
 * the alphabet and deliberately remains unchanged so validation can reject it.
 */
export function normalizeManualPairingCode(value: string): string {
    return value
        .toUpperCase()
        .replace(/[\s-]+/gu, '')
        .replace(/O/gu, '0')
        .replace(/[IL]/gu, '1');
}

export function validManualPairingCode(value: string): boolean {
    return /^[0-9A-HJKMNP-TV-Z]{10}$/u.test(normalizeManualPairingCode(value));
}

export function formatManualPairingCode(value: string): string {
    const normalized = normalizeManualPairingCode(value).slice(0, 10);
    return normalized.length > 5
        ? `${normalized.slice(0, 5)}-${normalized.slice(5)}`
        : normalized;
}

export function attendanceHeadline(checks: AttendanceChecks): {
    label: string;
    tone: AttendanceHeadlineTone;
} {
    if (checks.morningChecked && checks.eveningChecked) {
        return {label: '오늘 출석 완료', tone: 'success'};
    }
    if (checks.morningChecked) {
        return {label: '오후 출석 확인 필요', tone: 'warning'};
    }
    if (checks.eveningChecked) {
        return {label: '오전 출석 확인 필요', tone: 'warning'};
    }
    return {label: '오늘 출석 확인 필요', tone: 'warning'};
}

/**
 * Projects only the server-authoritative counts. Local freshness is an
 * additional fail-closed gate and never triggers a client-side recalculation.
 */
export function laundryCapacity(
    capacity: LaundryCapacitySnapshot | null,
    locallyReliable: boolean,
): LaundryCapacityView {
    return {
        men: locallyReliable && capacity?.men.reliable === true
            ? capacity.men.startableLoads
            : null,
        women: locallyReliable && capacity?.women.reliable === true
            ? capacity.women.startableLoads
            : null,
    };
}
