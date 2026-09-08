import assert from 'node:assert/strict';

import {describe, test} from 'vitest';

import type {DesktopConnectionState} from '@/api/dashboard-api';

import {dashboardAccountStatus, personalAccessState} from './dashboard-account-state';

const cachedConnection: DesktopConnectionState = {
    state: 'connected',
    credentialPersistent: true,
    lastVerifiedAt: '2026-09-08T08:30:00.000Z',
    lastSeenAt: '2026-09-08T08:30:00.000Z',
    health: 'online',
    lmsSessionState: 'connected',
};

describe('dashboardAccountStatus cached refetch failure', () => {
    test('캐시된 연결 데이터가 있어도 재조회 오류를 인증 성공으로 판정하지 않는다', () => {
        const status = dashboardAccountStatus('desktop', {
            data: cachedConnection,
            isPending: false,
            isError: true,
        });

        assert.deepEqual(status, {
            serverSession: 'unavailable',
            lmsAuthentication: 'unavailable',
        });
        assert.deepEqual(
            personalAccessState('desktop-session', status, {
                data: undefined,
                isPending: false,
                isError: false,
            }),
            {status: 'error', reason: 'server-error', retryable: true},
        );
    });
});
