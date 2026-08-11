import assert from 'node:assert/strict';
import {test} from 'vitest';
import {
    companionAuthenticationRequired,
    dashboardRouteFromHash,
    dashboardRouteForSurface,
    resolveDashboardSurface,
} from './surface';

test('해시 경로는 대시보드 메뉴로 해석하고 알 수 없는 값은 오늘 홈으로 돌린다', () => {
    assert.equal(dashboardRouteFromHash('#home'), 'home');
    assert.equal(dashboardRouteFromHash('#attendance'), 'attendance');
    assert.equal(dashboardRouteFromHash('#laundry'), 'laundry');
    assert.equal(dashboardRouteFromHash('#meals'), 'meals');
    assert.equal(dashboardRouteFromHash('#notifications'), 'notifications');
    assert.equal(dashboardRouteFromHash('#connections'), 'connections');
    assert.equal(dashboardRouteFromHash('#devices'), 'home');
    assert.equal(dashboardRouteFromHash('#unknown'), 'home');
});

test('Tauri, 연결된 모바일, 공개 웹을 기능 표면으로 분리한다', () => {
    assert.equal(resolveDashboardSurface({runningInTauri: true}).kind, 'desktop');
    assert.equal(resolveDashboardSurface({
        runningInTauri: false,
        standalone: true,
    }).kind, 'companion');
    assert.equal(resolveDashboardSurface({runningInTauri: false}).kind, 'public');
});

test('일반 웹에서는 공개 생활 정보 경로만 허용한다', () => {
    assert.equal(dashboardRouteForSurface('#home', 'public'), 'home');
    assert.equal(dashboardRouteForSurface('#attendance', 'public'), 'home');
    assert.equal(dashboardRouteForSurface('#notifications', 'public'), 'home');
    assert.equal(dashboardRouteForSurface('#connections', 'public'), 'home');
    assert.equal(dashboardRouteForSurface('#laundry', 'public'), 'laundry');
    assert.equal(dashboardRouteForSurface('#meals', 'public'), 'meals');
    assert.equal(dashboardRouteForSurface('#attendance', 'companion'), 'attendance');
    assert.equal(dashboardRouteForSurface('#notifications', 'desktop'), 'notifications');
});

test('모바일 세션 해지·만료 오류를 일반 장애가 아닌 재연결 상태로 분류한다', () => {
    for (const code of [
        'HTTP_401',
        'UNAUTHORIZED',
        'AUTHENTICATION_REQUIRED',
        'SESSION_EXPIRED',
        'MOBILE_SESSION_REQUIRED',
    ]) {
        assert.equal(companionAuthenticationRequired(new Error(code)), true);
    }
    assert.equal(companionAuthenticationRequired(new Error('UPSTREAM_UNAVAILABLE')), false);
    assert.equal(companionAuthenticationRequired('AUTHENTICATION_REQUIRED'), false);
});
