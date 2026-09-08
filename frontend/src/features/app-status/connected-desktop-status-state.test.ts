import assert from 'node:assert/strict';

import {describe, test, vi} from 'vitest';

import type {AttendanceDashboard} from '@/api/dashboard-api';

import {
    desktopLastSyncedAt,
    desktopMobileSessionCount,
    failedDesktopStatusProducers,
    retryFailedDesktopStatusProducers,
    type DesktopStatusProducer,
} from './connected-desktop-status-state';

const syncedAt = '2026-09-08T08:30:00.000Z';
const attendance: AttendanceDashboard = {
    state: 'loaded',
    attendance: {
        status: 'available',
        freshness: 'fresh',
        lastSyncedAt: syncedAt,
        snapshot: {
            attendanceDate: '2026-09-08',
            cohortId: 'jungle-1',
            cohortStatus: 'active',
            cohortStartDate: '2026-09-01',
            cohortEndDate: '2026-12-31',
            morningChecked: true,
            eveningChecked: false,
            collectedAt: syncedAt,
        },
        source: 'server',
        syncState: 'synced',
    },
    devices: [],
};

describe('desktop app-status query state', () => {
    test('출석 캐시가 있어도 재조회 실패를 정상 동기화로 표시하지 않는다', () => {
        assert.deepEqual(
            desktopLastSyncedAt('connected', {
                data: attendance,
                isError: true,
                isPending: false,
            }),
            {kind: 'stale', observedAt: syncedAt},
        );
        assert.equal(
            desktopLastSyncedAt('connected', {
                data: attendance,
                isError: false,
                isPending: false,
            }),
            syncedAt,
        );
    });

    test('계정 상태가 저하되거나 모바일 재조회가 실패하면 캐시 수를 정상으로 판정하지 않는다', () => {
        assert.deepEqual(
            desktopLastSyncedAt('error', {
                data: attendance,
                isError: false,
                isPending: false,
            }),
            {kind: 'stale', observedAt: syncedAt},
        );
        assert.equal(
            desktopMobileSessionCount(true, {
                data: [{status: 'active'}, {status: 'revoked'}],
                isError: true,
                isPending: false,
            }),
            'unavailable',
        );
        assert.equal(
            desktopMobileSessionCount(true, {
                data: [{status: 'active'}, {status: 'revoked'}],
                isError: false,
                isPending: false,
            }),
            1,
        );
    });

    test('실패한 producer만 모두 재시도하고 refetch reject를 UI 밖으로 전파하지 않는다', async () => {
        const rejectedRefetch = vi.fn<() => Promise<void>>(async () => {
            throw new Error('REFETCH_FAILED');
        });
        const resolvedRefetch = vi.fn<() => Promise<void>>(async () => undefined);
        const healthyRefetch = vi.fn<() => Promise<void>>(async () => undefined);
        const producers: DesktopStatusProducer[] = [
            {
                label: 'PC 연결',
                data: {cached: true},
                isError: true,
                isFetching: false,
                refetch: rejectedRefetch,
            },
            {
                label: '출석 동기화',
                data: {cached: true},
                isError: true,
                isFetching: false,
                refetch: resolvedRefetch,
            },
            {
                label: '모바일 세션',
                data: [],
                isError: false,
                isFetching: false,
                refetch: healthyRefetch,
            },
        ];

        assert.deepEqual(
            failedDesktopStatusProducers(producers).map(({label}) => label),
            ['PC 연결', '출석 동기화'],
        );
        await assert.doesNotReject(() => retryFailedDesktopStatusProducers(producers));
        assert.equal(rejectedRefetch.mock.calls.length, 1);
        assert.equal(resolvedRefetch.mock.calls.length, 1);
        assert.equal(healthyRefetch.mock.calls.length, 0);
    });
});
