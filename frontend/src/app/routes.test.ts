import {describe, expect, test} from 'vitest';

import {
    DASHBOARD_ROUTE_META,
    connectionsRouteSearch,
    dashboardRouteAccess,
    isMixedDashboardRoute,
    isPersonalDashboardRoute,
    isPublicDashboardRoute,
    normalizeConnectionsSearch,
    normalizeDashboardReturnTarget,
} from './routes';

describe('dashboard route access', () => {
    test('급식 화면의 사용자 용어를 급식으로 통일한다', () => {
        expect(DASHBOARD_ROUTE_META.meals).toEqual({label: '급식', shortLabel: '급식'});
    });

    test('공개·개인·혼합 접근 범위를 구분한다', () => {
        for (const route of ['home', 'laundry', 'meals', 'install'] as const) {
            expect(dashboardRouteAccess(route)).toBe('public');
            expect(isPublicDashboardRoute(route)).toBe(true);
        }
        for (const route of ['attendance', 'notifications'] as const) {
            expect(dashboardRouteAccess(route)).toBe('personal');
            expect(isPersonalDashboardRoute(route)).toBe(true);
        }
        expect(dashboardRouteAccess('connections')).toBe('mixed');
        expect(isMixedDashboardRoute('connections')).toBe(true);
    });
});

describe('connections route search', () => {
    test('앱 상태를 포함한 네 탭을 단일 typed search 계약으로 제공한다', () => {
        expect(connectionsRouteSearch('status')).toEqual({tab: 'status'});
        expect(connectionsRouteSearch('notifications')).toEqual({tab: 'notifications'});
        expect(connectionsRouteSearch('services')).toEqual({tab: 'services'});
        expect(connectionsRouteSearch('devices')).toEqual({tab: 'devices'});
    });

    test('탭과 안전한 내부 복귀 경로를 만든다', () => {
        expect(connectionsRouteSearch('devices', '/attendance')).toEqual({
            tab: 'devices',
            returnTo: '/attendance',
        });
        expect(connectionsRouteSearch('services')).toEqual({tab: 'services'});
    });

    test('잘못된 탭은 기본값으로, 위험한 복귀 경로는 없음으로 정규화한다', () => {
        expect(
            normalizeConnectionsSearch({tab: 'unknown', returnTo: 'https://evil.example'}),
        ).toEqual({tab: 'status'});
        expect(
            normalizeConnectionsSearch({tab: ['devices'], returnTo: '/attendance?edit=1'}),
        ).toEqual({tab: 'status'});
        expect(normalizeDashboardReturnTarget('/connections')).toBeUndefined();
        expect(normalizeDashboardReturnTarget('//evil.example')).toBeUndefined();
        expect(normalizeDashboardReturnTarget('/privacy')).toBe('/privacy');
        expect(normalizeDashboardReturnTarget('/')).toBe('/');
    });
});
