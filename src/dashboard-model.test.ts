import assert from 'node:assert/strict';
import {test} from 'vitest';
import {
    attendanceHeadline,
    companionAuthenticationRequired,
    dashboardRouteFromHash,
    dashboardRouteForSurface,
    laundryCapacity,
    normalizeManualPairingCode,
    resolveDashboardSurface,
    validManualPairingCode,
} from './dashboard-model';

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

test('Crockford Base32 연결 코드는 구분자를 제거하고 혼동 문자를 정규화한다', () => {
    assert.equal(normalizeManualPairingCode('abCde-23oIl'), 'ABCDE23011');
    assert.equal(normalizeManualPairingCode(' ab cde 2345 '), 'ABCDE2345');
    assert.equal(normalizeManualPairingCode('abcdu-2345'), 'ABCDU2345');
    assert.equal(validManualPairingCode('ABCDE-23011'), true);
    assert.equal(validManualPairingCode('ABCDU-2345'), false);
    assert.equal(validManualPairingCode('ABCD-2345'), false);
});

test('출석 snapshot은 오전·오후 확인 조합을 사실 그대로 요약한다', () => {
    assert.deepEqual(attendanceHeadline({morningChecked: true, eveningChecked: true}), {
        label: '오늘 출석 완료',
        tone: 'success',
    });
    assert.deepEqual(attendanceHeadline({morningChecked: true, eveningChecked: false}), {
        label: '오후 출석 확인 필요',
        tone: 'warning',
    });
    assert.deepEqual(attendanceHeadline({morningChecked: false, eveningChecked: true}), {
        label: '오전 출석 확인 필요',
        tone: 'warning',
    });
    assert.deepEqual(attendanceHeadline({morningChecked: false, eveningChecked: false}), {
        label: '오늘 출석 확인 필요',
        tone: 'warning',
    });
});

const authoritativeCapacity = {
    basis: 'WASHER_AND_DRYER_HEADROOM_60_MIN' as const,
    men: {
        access: 'men' as const,
        washerAvailable: 4,
        projectedDryerSupply: 5,
        pendingDryerLoads: 2,
        dryerHeadroom: 3,
        startableLoads: 3,
        reliable: true,
    },
    women: {
        access: 'women' as const,
        washerAvailable: 2,
        projectedDryerSupply: 2,
        pendingDryerLoads: 1,
        dryerHeadroom: 1,
        startableLoads: 1,
        reliable: true,
    },
};

test('세탁 현황은 서버가 산출한 남녀별 exact count만 그대로 표시한다', () => {
    assert.deepEqual(laundryCapacity(authoritativeCapacity, true), {
        men: 3,
        women: 1,
    });
});

test('서버 신뢰 표시나 로컬 snapshot age가 하나라도 부족하면 횟수를 추측하지 않는다', () => {
    assert.deepEqual(laundryCapacity(authoritativeCapacity, false), {men: null, women: null});
    assert.deepEqual(laundryCapacity(null, true), {men: null, women: null});
    assert.deepEqual(laundryCapacity({
        ...authoritativeCapacity,
        women: {...authoritativeCapacity.women, reliable: false, startableLoads: null},
    }, true), {men: 3, women: null});
});
