import {describe, expect, test} from 'vitest';

import type {DesktopUpdateStatus} from '@/platform/contracts';

import {
    authenticationStateFromProducer,
    desktopUpdateObservationFromQuery,
    notificationPermissionFromRuntime,
    pushStateFromRuntime,
    serviceWorkerObservation,
} from './app-status-observations';

function update(
    status: DesktopUpdateStatus['status'],
    overrides: Partial<DesktopUpdateStatus> = {},
): DesktopUpdateStatus {
    return {
        status,
        currentVersion: '0.5.9',
        availableVersion: null,
        policy: null,
        progress: null,
        errorCode: null,
        ...overrides,
    };
}

describe('app status producer observations', () => {
    test('기존 desktop data보다 새 error, offline, recovering 관측을 우선한다', () => {
        const connected = {status: 'connected', reason: 'authenticated'} as const;

        expect(
            authenticationStateFromProducer(connected, {
                hasData: true,
                isError: true,
                isFetching: false,
                fetchStatus: 'idle',
            }),
        ).toEqual({status: 'server-error'});
        expect(
            authenticationStateFromProducer(connected, {
                hasData: true,
                isError: false,
                isFetching: false,
                fetchStatus: 'paused',
            }),
        ).toEqual({status: 'offline'});
        expect(
            authenticationStateFromProducer(connected, {
                hasData: true,
                isError: false,
                isFetching: true,
                fetchStatus: 'fetching',
            }),
        ).toEqual({status: 'recovering'});
    });

    test('canonical updater status와 cached mandatory를 보존하면서 새 query 오류를 표시한다', () => {
        const status = update('mandatory', {
            availableVersion: '0.6.0',
            policy: 'mandatory',
        });

        expect(
            desktopUpdateObservationFromQuery({
                data: status,
                dataUpdatedAt: Date.parse('2026-09-08T01:00:00.000Z'),
                isError: true,
                isPending: false,
                isStale: true,
            }),
        ).toEqual({
            state: status,
            queryStatus: 'error',
            checkedAt: '2026-09-08T01:00:00.000Z',
        });
    });

    test('브라우저 Notification.permission을 실제 값과 unsupported로 구분한다', () => {
        expect(notificationPermissionFromRuntime({permission: 'granted'})).toBe('granted');
        expect(notificationPermissionFromRuntime({permission: 'denied'})).toBe('denied');
        expect(notificationPermissionFromRuntime(undefined)).toBe('unsupported');
    });

    test('권한, 로컬/서버 조정, 실제 테스트 기록을 canonical push 상태로 합친다', () => {
        expect(pushStateFromRuntime('default', {status: 'none'}, null)).toEqual({
            status: 'permission-default',
        });
        expect(pushStateFromRuntime('granted', {status: 'local-only'}, null)).toEqual({
            status: 'subscribed-local',
        });
        expect(
            pushStateFromRuntime(
                'granted',
                {status: 'matched-registered', serverEvidence: 'registration-response'},
                {state: {status: 'arrived'}},
            ),
        ).toEqual({status: 'arrived'});
        expect(
            pushStateFromRuntime(
                'granted',
                {status: 'matched-registration-unverified'},
                {state: {status: 'arrived'}},
            ),
        ).toEqual({status: 'subscribed-local'});
        expect(
            pushStateFromRuntime(
                'granted',
                {status: 'matched-registered'},
                {
                    state: {status: 'arrived'},
                },
            ),
        ).toEqual({status: 'error'});
    });

    test('플랫폼 service worker 관측에 현재 build version을 붙인다', () => {
        expect(
            serviceWorkerObservation(
                {status: 'active', scriptUrl: 'https://app.example/sw.js'},
                '0.5.9',
            ),
        ).toEqual({
            status: 'active',
            version: '0.5.9',
            scriptUrl: 'https://app.example/sw.js',
        });
        expect(serviceWorkerObservation({status: 'missing'}, '0.5.9')).toEqual({
            status: 'missing',
            version: '0.5.9',
        });
    });
});
