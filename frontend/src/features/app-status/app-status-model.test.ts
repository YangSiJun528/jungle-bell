import {describe, expect, test} from 'vitest';

import type {DesktopUpdateStatus} from '@/platform/contracts';

import {appStatusRows, type AppStatusInput} from './app-status-model';

function update(
    status: DesktopUpdateStatus['status'],
    overrides: Partial<DesktopUpdateStatus> = {},
) {
    return {
        state: {
            status,
            currentVersion: '0.5.9',
            availableVersion: null,
            policy: null,
            progress: null,
            errorCode: null,
            ...overrides,
        } as DesktopUpdateStatus,
        queryStatus: 'fresh' as const,
        checkedAt: null,
    };
}

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
            osNotification: null,
            update: {
                ...update('latest'),
                checkedAt: '2026-09-08T01:01:00.000Z',
            },
        };

        expect(appStatusRows(input).map(({id}) => id)).toEqual([
            'lms-authentication',
            'server-credential',
            'last-sync',
            'mobile-sessions',
            'os-notification',
            'update',
        ]);
        expect(row(input, 'os-notification')).toMatchObject({
            status: 'attention',
            statusText: '테스트 기록 없음',
        });
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
            osNotification: null,
            update: update('latest'),
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
            osNotification: null,
            update: {state: null, queryStatus: 'unavailable', checkedAt: null},
        };

        expect(row(input, 'server-credential')).toMatchObject({
            status: 'error',
            statusText: '복구 필요',
            action: {tab: 'devices'},
        });
    });

    test('canonical updater의 status, policy, progress, errorCode를 직접 표시한다', () => {
        const base: Omit<AppStatusInput & {surface: 'desktop'}, 'update'> = {
            surface: 'desktop',
            lmsAuthentication: 'authenticated',
            serverSession: 'stored',
            lastSyncedAt: null,
            mobileSessionCount: 0,
            osNotification: null,
        };

        expect(row({...base, update: update('checking')}, 'update')).toMatchObject({
            status: 'checking',
            statusText: '확인 중',
        });
        expect(row({...base, update: update('latest')}, 'update')).toMatchObject({
            status: 'ready',
            statusText: '최신 버전 · v0.5.9',
        });
        expect(
            row(
                {
                    ...base,
                    update: update('mandatory', {
                        availableVersion: '0.6.0',
                        policy: 'mandatory',
                    }),
                },
                'update',
            ),
        ).toMatchObject({
            status: 'attention',
            statusText: '0.6.0 업데이트 가능',
            action: {tab: 'services'},
        });
        expect(
            row(
                {
                    ...base,
                    update: update('downloading', {
                        availableVersion: '0.6.0',
                        policy: 'optional',
                        progress: {downloadedBytes: 25, totalBytes: 100},
                    }),
                },
                'update',
            ),
        ).toMatchObject({status: 'checking', statusText: '다운로드 중 25%'});
        expect(
            row(
                {
                    ...base,
                    update: update('failed', {errorCode: 'UPDATE_CHECK_FAILED'}),
                },
                'update',
            ),
        ).toMatchObject({status: 'error', statusText: '업데이트 실패'});
    });

    test.each([
        ['test-sending', 'checking', '표시 확인 대기'],
        ['arrived', 'ready', '실제 표시 확인'],
        ['not-arrived', 'error', '표시되지 않음'],
        ['error', 'error', '테스트 실패'],
    ] as const)('PC 알림 테스트 %s 기록을 행 상태로 표시한다', (testStatus, status, statusText) => {
        const input: AppStatusInput = {
            surface: 'desktop',
            lmsAuthentication: 'authenticated',
            serverSession: 'stored',
            lastSyncedAt: null,
            mobileSessionCount: 0,
            osNotification: {
                version: 1,
                surface: 'pc',
                state: {status: testStatus},
                testedAt: '2026-09-08T02:03:04.000Z',
            },
            update: update('latest'),
        };

        expect(row(input, 'os-notification')).toMatchObject({status, statusText});
    });

    test('PWA는 실제 권한, 로컬 구독, 서버 등록 ID, 마지막 테스트, SW 버전을 표시한다', () => {
        const input: AppStatusInput = {
            surface: 'pwa',
            authentication: {status: 'authenticated'},
            sessionExpiresAt: '2026-09-09T01:00:00.000Z',
            notificationPermission: 'granted',
            pushState: {status: 'arrived'},
            pushLifecycle: {
                status: 'matched-registered',
                subscriptionId: `jbps_${'a'.repeat(64)}`,
                serverEvidence: 'registration-response',
            },
            lastTest: {
                version: 1,
                surface: 'pwa',
                state: {status: 'arrived'},
                testedAt: '2026-09-08T02:03:04.000Z',
            },
            serviceWorker: {
                status: 'active',
                version: '0.5.9',
                scriptUrl: 'https://app.example/sw.js',
            },
        };

        expect(row(input, 'local-push')).toMatchObject({status: 'ready', statusText: '구독됨'});
        expect(row(input, 'server-registration')).toMatchObject({
            status: 'ready',
            statusText: `등록됨 · ${'a'.repeat(8)}`,
        });
        expect(row(input, 'last-test')).toMatchObject({
            status: 'ready',
            statusText: '실제 도착 확인',
        });
        expect(row(input, 'service-worker')).toMatchObject({
            status: 'ready',
            statusText: 'v0.5.9 활성',
        });
        expect(appStatusRows(input).every(({status}) => status !== 'unavailable')).toBe(true);
    });

    test('저장 기록만 일치한 서버 푸시 등록은 ready로 표시하지 않는다', () => {
        const input: AppStatusInput = {
            surface: 'pwa',
            authentication: {status: 'authenticated'},
            sessionExpiresAt: '2026-09-09T01:00:00.000Z',
            notificationPermission: 'granted',
            pushState: {status: 'subscribed-local'},
            pushLifecycle: {
                status: 'matched-registration-unverified',
                subscriptionId: `jbps_${'a'.repeat(64)}`,
            },
            lastTest: null,
            serviceWorker: {status: 'active', version: '0.5.9', scriptUrl: '/sw.js'},
        };

        expect(row(input, 'local-push')).toMatchObject({
            status: 'attention',
            statusText: '구독됨',
        });
        expect(row(input, 'server-registration')).toMatchObject({
            status: 'attention',
            statusText: '서버 확인 필요',
        });
    });

    test('PWA의 누락·불일치·미등록 상태마다 실행 가능한 복구 CTA를 제공한다', () => {
        const input: AppStatusInput = {
            surface: 'pwa',
            authentication: {status: 'expired'},
            sessionExpiresAt: null,
            notificationPermission: 'denied',
            pushState: {status: 'error'},
            pushLifecycle: {status: 'mismatch'},
            lastTest: null,
            serviceWorker: {status: 'missing', version: '0.5.9'},
        };

        for (const id of [
            'personal-access',
            'notification-permission',
            'local-push',
            'server-registration',
            'last-test',
            'service-worker',
        ]) {
            expect(row(input, id).status).not.toBe('unavailable');
            expect(row(input, id).action.label.length).toBeGreaterThan(0);
        }
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
