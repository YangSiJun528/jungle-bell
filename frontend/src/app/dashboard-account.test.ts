import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {describe, test} from 'vitest';
import type {DesktopConnectionState} from '@/api/dashboard-api';
import {
    assertLmsAuthenticated,
    assertServerSessionReady,
    dashboardAccountStatus,
    normalizeLmsSessionStateEvent,
    personalAccessState,
    withLmsSessionState,
} from './dashboard-account-state';

const connected = (overrides: Partial<DesktopConnectionState> = {}): DesktopConnectionState => ({
    state: 'connected',
    credentialPersistent: true,
    lastVerifiedAt: '2026-08-12T12:00:00.000Z',
    lastSeenAt: '2026-08-12T12:00:00.000Z',
    health: 'online',
    lmsSessionState: 'connected',
    ...overrides,
});

describe('dashboard account status', () => {
    test('desktop의 서버 credential과 LMS 인증을 서로 다른 전역 상태로 만든다', () => {
        assert.deepEqual(
            dashboardAccountStatus('desktop', {data: connected(), isPending: false, isError: false}),
            {serverSession: 'stored', lmsAuthentication: 'authenticated'},
        );
        assert.deepEqual(
            dashboardAccountStatus('desktop', {
                data: connected({
                    state: 'disconnected',
                    credentialPersistent: false,
                    health: null,
                    lmsSessionState: 'login-required',
                }),
                isPending: false,
                isError: false,
            }),
            {serverSession: 'missing', lmsAuthentication: 'required'},
        );
        assert.deepEqual(
            dashboardAccountStatus('desktop', {
                data: connected({credentialPersistent: false}),
                isPending: false,
                isError: false,
            }),
            {serverSession: 'memory-only', lmsAuthentication: 'authenticated'},
        );
    });

    test('초기 확인·실패·비 desktop surface를 구분한다', () => {
        assert.deepEqual(
            dashboardAccountStatus('desktop', {data: undefined, isPending: true, isError: false}),
            {serverSession: 'checking', lmsAuthentication: 'checking'},
        );
        assert.deepEqual(
            dashboardAccountStatus('desktop', {data: undefined, isPending: false, isError: true}),
            {serverSession: 'unavailable', lmsAuthentication: 'unavailable'},
        );
        assert.deepEqual(
            dashboardAccountStatus('browser', {data: undefined, isPending: false, isError: false}),
            {serverSession: 'not-applicable', lmsAuthentication: 'not-applicable'},
        );
    });

    test('웹·PWA 세션과 desktop 계정 상태를 공통 개인 접근 상태로 정규화한다', () => {
        const desktop = {serverSession: 'stored', lmsAuthentication: 'authenticated'} as const;
        assert.deepEqual(personalAccessState('none', desktop, {
            data: undefined,
            isPending: true,
            isError: false,
        }), {status: 'not-applicable'});
        assert.deepEqual(personalAccessState('cookie', desktop, {
            data: undefined,
            isPending: true,
            isError: false,
        }), {status: 'checking'});
        assert.deepEqual(personalAccessState('cookie', desktop, {
            data: null,
            isPending: false,
            isError: false,
        }), {status: 'unconnected'});
        assert.deepEqual(personalAccessState('cookie', desktop, {
            data: {authenticated: true, expiresAt: '2026-08-14T00:00:00.000Z'},
            isPending: false,
            isError: false,
        }), {status: 'connected'});
        assert.deepEqual(personalAccessState('cookie', desktop, {
            data: undefined,
            isPending: false,
            isError: true,
        }), {status: 'error'});
        assert.deepEqual(personalAccessState('cookie', desktop, {
            data: null,
            isPending: false,
            isError: true,
        }), {status: 'error'});
        assert.deepEqual(personalAccessState('desktop-session', desktop, {
            data: undefined,
            isPending: false,
            isError: false,
        }), {status: 'connected'});
        assert.deepEqual(personalAccessState('desktop-session', {
            serverSession: 'stored',
            lmsAuthentication: 'required',
        }, {
            data: undefined,
            isPending: false,
            isError: false,
        }), {status: 'unconnected'});
    });

    test('LMS 의존 작업은 인증 확인 전 호출하지 않는다', async () => {
        let calls = 0;
        const task = async () => { calls += 1; };

        assert.throws(
            () => assertLmsAuthenticated({serverSession: 'missing', lmsAuthentication: 'required'}),
            /LMS_AUTH_REQUIRED/,
        );
        assert.equal(calls, 0);

        assert.doesNotThrow(() => assertLmsAuthenticated({
            serverSession: 'stored',
            lmsAuthentication: 'authenticated',
        }));
        await task();
        assert.equal(calls, 1);

        assert.throws(
            () => assertServerSessionReady({serverSession: 'missing', lmsAuthentication: 'authenticated'}),
            /SERVER_SESSION_REQUIRED/,
        );
        assert.doesNotThrow(() => assertServerSessionReady({
            serverSession: 'memory-only',
            lmsAuthentication: 'authenticated',
        }));
    });

    test('네이티브 LMS 상태 이벤트는 엄격히 검증하고 기존 전역 캐시만 갱신한다', () => {
        assert.equal(normalizeLmsSessionStateEvent('connected'), 'connected');
        assert.equal(normalizeLmsSessionStateEvent('login-required'), 'login-required');
        assert.equal(normalizeLmsSessionStateEvent('CONNECTED'), null);
        assert.equal(normalizeLmsSessionStateEvent({state: 'connected'}), null);

        const current = connected({lmsSessionState: 'login-required'});
        assert.deepEqual(withLmsSessionState(current, 'connected'), {
            ...current,
            lmsSessionState: 'connected',
        });
        assert.equal(withLmsSessionState(undefined, 'connected'), undefined);
    });

    test('출석 HTTP는 LMS와 서버 세션을, 동기화 command는 LMS 인증을 요구한다', () => {
        const source = readFileSync(new URL('./use-dashboard-queries.ts', import.meta.url), 'utf8');
        assert.match(source, /enabled: account\.personalAccess\.status === 'connected'/u);
        assert.match(source, /if \(platform\.capabilities\.desktopAccount\) assertLmsAuthenticated\(account\.status\)/u);
        assert.match(source, /refreshPlatform: refreshDesktopPlatform \?/u);
        assert.match(
            source,
            /refreshAttendance: account\.personalAccess\.status === 'connected'[\s\S]{0,120}refreshDesktopAttendance/u,
        );
    });
});
