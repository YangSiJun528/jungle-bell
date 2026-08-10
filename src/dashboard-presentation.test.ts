import assert from 'node:assert/strict';
import {test} from 'vitest';
import {
    dashboardNavigationRoutes,
    dashboardRouteTitle,
    dashboardSurfaceBadge,
    dashboardSurfaceFooter,
} from './dashboard-presentation';

test('표면별 내비게이션은 공개 정보와 개인 기능을 명확히 분리한다', () => {
    assert.deepEqual(dashboardNavigationRoutes('public'), [
        'home',
        'laundry',
        'meals',
    ]);
    assert.deepEqual(dashboardNavigationRoutes('companion'), [
        'home',
        'attendance',
        'laundry',
        'meals',
        'notifications',
        'connections',
    ]);
    assert.deepEqual(dashboardNavigationRoutes('desktop'), [
        'home',
        'attendance',
        'laundry',
        'meals',
        'notifications',
        'connections',
    ]);
});

test('설치 PWA에는 모바일에서도 접근 가능한 PC 연결 경로가 있다', () => {
    assert.equal(dashboardNavigationRoutes('companion').includes('connections'), true);
});

test('경로 제목과 공통 셸 문구는 한 프레젠테이션 계약에서 제공한다', () => {
    assert.equal(dashboardRouteTitle('home'), '오늘');
    assert.equal(dashboardRouteTitle('connections'), 'PC 연결');
    assert.equal(dashboardSurfaceFooter('public'), '오늘의 공개 생활 정보');
    assert.equal(dashboardSurfaceFooter('companion'), '오늘의 출석 · 생활 정보 · 알림');
    assert.equal(dashboardSurfaceFooter('desktop'), '오늘의 출석 · 생활 정보 · 알림');
});

test('표면 배지는 실행 환경과 연결 상태를 일관된 상태색으로 표시한다', () => {
    assert.deepEqual(dashboardSurfaceBadge('public', {}), {
        label: '공개 웹',
        tone: 'neutral',
    });
    assert.deepEqual(dashboardSurfaceBadge('desktop', {desktopConnected: false}), {
        label: 'PC 앱',
        tone: 'warning',
    });
    assert.deepEqual(dashboardSurfaceBadge('desktop', {desktopConnected: true}), {
        label: 'PC 연결됨',
        tone: 'success',
    });
    assert.deepEqual(dashboardSurfaceBadge('companion', {companionAuthenticated: false}), {
        label: '연결 필요',
        tone: 'warning',
    });
    assert.deepEqual(dashboardSurfaceBadge('companion', {companionAuthenticated: true}), {
        label: '모바일 연결됨',
        tone: 'success',
    });
});
