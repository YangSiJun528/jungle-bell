import {describe, expect, test} from 'vitest';

import {
    connectionsRouteSearch,
    dashboardRouteAccess,
    isMixedDashboardRoute,
    isPersonalDashboardRoute,
    isPublicDashboardRoute,
    normalizeConnectionsSearch,
    normalizeDashboardReturnTarget,
} from './routes';

describe('dashboard route access', () => {
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
        ).toEqual({tab: 'notifications'});
        expect(
            normalizeConnectionsSearch({tab: ['devices'], returnTo: '/attendance?edit=1'}),
        ).toEqual({tab: 'notifications'});
        expect(normalizeDashboardReturnTarget('/connections')).toBeUndefined();
        expect(normalizeDashboardReturnTarget('//evil.example')).toBeUndefined();
        expect(normalizeDashboardReturnTarget('/privacy')).toBe('/privacy');
        expect(normalizeDashboardReturnTarget('/')).toBe('/');
    });
});
