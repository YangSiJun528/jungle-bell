import {describe, expect, test} from 'vitest';

import {appStatusRows, type AppStatusInput} from './app-status-model';

function row(input: AppStatusInput, id: string) {
    const found = appStatusRows(input).find((candidate) => candidate.id === id);
    expect(found).toBeDefined();
    return found!;
}

describe('app status rows', () => {
    test('PC는 로그인, credential, 동기화, 모바일, OS 알림, 업데이트 상태를 구분한다', () => {
        const input: AppStatusInput = {
            surface: 'desktop',
            lmsAuthentication: 'authenticated',
            serverSession: 'stored',
            lastSyncedAt: '2026-09-08T01:00:00.000Z',
            mobileSessionCount: 2,
            update: {kind: 'latest', checkedAt: '2026-09-08T01:01:00.000Z'},
        };

        expect(appStatusRows(input).map(({id}) => id)).toEqual([
            'lms-authentication',
            'server-credential',
            'last-sync',
            'mobile-sessions',
            'os-notification',
            'update',
        ]);
        expect(row(input, 'os-notification').status).toBe('unavailable');
    });

    test('서버가 stale로 표시한 출석 동기화를 준비 완료로 과장하지 않는다', () => {
        const input: AppStatusInput = {
            surface: 'desktop',
            lmsAuthentication: 'authenticated',
            serverSession: 'stored',
            lastSyncedAt: {
                kind: 'stale',
                observedAt: '2026-09-08T01:00:00.000Z',
            },
            mobileSessionCount: 1,
            update: {kind: 'latest'},
        };

        expect(row(input, 'last-sync')).toMatchObject({
            status: 'attention',
            statusText: '오래된 동기화',
        });
    });

    test('이미 알려진 PC credential 복구 필요 상태를 확인 불가로 숨기지 않는다', () => {
        const input: AppStatusInput = {
            surface: 'desktop',
            lmsAuthentication: 'authenticated',
            serverSession: 'recovery-required',
            lastSyncedAt: null,
            mobileSessionCount: null,
            update: {kind: 'unavailable'},
        };

        expect(row(input, 'server-credential')).toMatchObject({
            status: 'error',
            statusText: '복구 필요',
            action: {tab: 'devices'},
        });
    });

    test('PWA는 확인 계약이 없는 로컬 구독과 서버 등록을 준비됨으로 추정하지 않는다', () => {
        const input: AppStatusInput = {
            surface: 'pwa',
            personalAccess: 'connected',
            sessionExpiresAt: '2026-09-09T01:00:00.000Z',
            notificationPermission: 'granted',
        };

        expect(row(input, 'local-push').status).toBe('unavailable');
        expect(row(input, 'server-registration').status).toBe('unavailable');
        expect(row(input, 'last-test').status).toBe('unavailable');
        expect(row(input, 'service-worker').status).toBe('unavailable');
    });

    test('일반 Web은 공개 사용과 설치 지원/설치 여부만 표시한다', () => {
        const input: AppStatusInput = {
            surface: 'web',
            installSupported: true,
            installed: false,
        };
        expect(appStatusRows(input).map(({id}) => id)).toEqual([
            'public-access',
            'install-support',
            'installation',
        ]);
        expect(row(input, 'public-access').status).toBe('ready');
    });

    test('일반 Web의 알려진 미지원·미설치 상태를 확인 불가로 숨기지 않는다', () => {
        const input: AppStatusInput = {
            surface: 'web',
            installSupported: false,
            installed: false,
        };

        expect(row(input, 'install-support')).toMatchObject({
            status: 'attention',
            statusText: '지원되지 않음',
        });
        expect(row(input, 'installation')).toMatchObject({
            status: 'attention',
            statusText: '설치되지 않음',
        });
    });
});
