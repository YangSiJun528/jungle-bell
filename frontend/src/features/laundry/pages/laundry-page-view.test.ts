import {describe, expect, it} from 'vitest';

import type {DashboardLaundrySnapshot} from '@/api/dashboard-api';
import type {DashboardLaundryMachine, LaundryCapacitySnapshot} from '@/domain/laundry/capacity';

import {
    capacityCards,
    filterAndSortLaundryMachineViews,
    laundryPageState,
    laundrySummaryFromSnapshot,
    type LaundryMachineFilterInput,
} from './laundry-page-view';

const capacity: LaundryCapacitySnapshot = {
    basis: 'WASHER_AND_DRYER_HEADROOM_60_MIN',
    men: {
        access: 'men',
        washerAvailable: 3,
        projectedDryerSupply: 2,
        pendingDryerLoads: 1,
        dryerHeadroom: 1,
        startableLoads: 1,
        reliable: true,
    },
    women: {
        access: 'women',
        washerAvailable: 2,
        projectedDryerSupply: 1,
        pendingDryerLoads: 1,
        dryerHeadroom: 0,
        startableLoads: 0,
        reliable: false,
    },
};

describe('capacityCards', () => {
    it('서버가 신뢰 가능하다고 표시한 수치만 시작 가능 횟수로 노출한다', () => {
        expect(capacityCards(capacity, true)).toEqual([
            expect.objectContaining({
                access: 'men',
                count: 1,
                label: '남성 가능',
                status: 'available',
            }),
            expect.objectContaining({
                access: 'women',
                count: null,
                label: '여성 가능',
                status: 'checking',
            }),
        ]);
    });

    it('스냅샷 자체가 오래되었으면 모든 수치를 확인 중으로 처리한다', () => {
        expect(capacityCards(capacity, false).map(({count, status}) => ({count, status}))).toEqual([
            {count: null, status: 'checking'},
            {count: null, status: 'checking'},
        ]);
    });
});

describe('laundrySummaryFromSnapshot', () => {
    it('신뢰할 수 있는 스냅샷만 카운트를 노출한다', () => {
        expect(
            laundrySummaryFromSnapshot({
                snapshot: {
                    ...baseSnapshot,
                    machines: [{...baseMachine, id: '워시타워_1'}],
                },
            }),
        ).toEqual({men: 1, women: 1});

        expect(
            laundrySummaryFromSnapshot({
                snapshot: {
                    ...baseSnapshot,
                    quality: {
                        ...baseSnapshot.quality,
                        collectorHealthy: false,
                    },
                },
            }),
        ).toEqual({men: null, women: null});
    });
});

describe('laundryPageState', () => {
    it('loading/normal/empty/stale/offline/error/recovered를 구분하고 캐시 재사용 문구를 준비한다', () => {
        expect(
            laundryPageState({
                snapshot: null,
                queryError: null,
                manualRefreshError: null,
            }).kind,
        ).toBe('loading');

        const normal = laundryPageState({
            snapshot: baseSnapshot,
            queryError: null,
            manualRefreshError: null,
        });
        expect(normal.kind).toBe('normal');
        expect(normal.allowWatchCreation).toBe(true);
        expect(normal.lastKnownLabel).toBe('방금 전');

        expect(
            laundryPageState({
                snapshot: {...baseSnapshot, machines: []},
                queryError: null,
                manualRefreshError: null,
            }),
        ).toMatchObject({kind: 'empty', allowWatchCreation: false});

        expect(
            laundryPageState({
                snapshot: {
                    ...baseSnapshot,
                    quality: {
                        ...baseSnapshot.quality,
                        collectorHealthy: false,
                    },
                },
                queryError: null,
                manualRefreshError: null,
            }),
        ).toMatchObject({
            kind: 'stale',
            canRetry: true,
            allowWatchCreation: false,
            reason: 'collector-unavailable',
            message: expect.stringContaining('실시간 정보가 아닙니다.'),
        });

        expect(
            laundryPageState({
                snapshot: baseSnapshot,
                isOffline: true,
                queryError: null,
                manualRefreshError: null,
            }),
        ).toMatchObject({
            kind: 'offline',
            canRetry: false,
            reason: 'offline',
            allowWatchCreation: false,
        });

        expect(
            laundryPageState({
                snapshot: {
                    ...baseSnapshot,
                    quality: {
                        ...baseSnapshot.quality,
                        collection: 'STALE',
                        sourceFreshness: 'REFRESH_OVERDUE',
                    },
                },
                queryError: null,
                manualRefreshError: null,
            }),
        ).toMatchObject({
            kind: 'stale',
            canRetry: true,
            message: expect.stringContaining('실시간 정보가 아닙니다.'),
        });

        expect(
            laundryPageState({
                snapshot: baseSnapshot,
                queryError: new Error('refresh failed'),
                manualRefreshError: null,
            }),
        ).toMatchObject({
            kind: 'stale',
            canRetry: true,
            reason: 'refresh-failed',
            message: expect.stringContaining('실시간 정보가 아닙니다.'),
        });

        expect(
            laundryPageState({
                snapshot: baseSnapshot,
                queryError: null,
                manualRefreshError: null,
                recovered: true,
            }).kind,
        ).toBe('recovered');
    });

    it('데이터가 없는 최초 요청은 loading/offline/error를 구분한다', () => {
        expect(
            laundryPageState({
                snapshot: null,
                isPending: true,
                queryError: null,
                manualRefreshError: null,
            }).kind,
        ).toBe('loading');
        expect(
            laundryPageState({
                snapshot: null,
                isOffline: true,
                queryError: null,
                manualRefreshError: null,
            }).kind,
        ).toBe('offline');
        expect(
            laundryPageState({
                snapshot: null,
                queryError: new Error('initial failure'),
                manualRefreshError: null,
            }).kind,
        ).toBe('error');
    });
});

describe('filterAndSortLaundryMachineViews', () => {
    const filterInput: Omit<LaundryMachineFilterInput, 'zoneFilter' | 'stateFilter'> = {
        machines: [
            {
                ...baseMachine,
                id: '워시타워_1',
                zone: 'men',
                washer: {
                    appliance: 'washer',
                    operationalStatus: 'IDLE',
                    projection: {status: 'IDLE', remainingMinutes: 0},
                },
                dryer: {
                    appliance: 'dryer',
                    operationalStatus: 'RUNNING',
                    projection: {status: 'ESTIMATED_RUNNING', remainingMinutes: 15},
                },
            },
            {
                ...baseMachine,
                id: '워시타워_2',
                zone: 'common',
                washer: {
                    appliance: 'washer',
                    operationalStatus: 'ERROR',
                    errorCode: 'OE',
                    projection: {status: 'ERROR', remainingMinutes: 0},
                },
                dryer: {
                    appliance: 'dryer',
                    operationalStatus: 'IDLE',
                    projection: {status: 'IDLE', remainingMinutes: 0},
                },
            },
            {
                ...baseMachine,
                id: '워시타워_3',
                zone: 'women',
                washer: {
                    appliance: 'washer',
                    operationalStatus: 'RUNNING',
                    projection: {status: 'ESTIMATED_RUNNING', remainingMinutes: 10},
                },
                dryer: {
                    appliance: 'dryer',
                    operationalStatus: 'PAUSED',
                    projection: {status: 'PAUSED', remainingMinutes: 0},
                },
            },
        ],
        nowMs: NOW_MS,
        prioritizeProblems: true,
    };

    it('구역 필터와 상태 필터로 대상 리스트를 축소한다', () => {
        const {views} = filterAndSortLaundryMachineViews({
            ...filterInput,
            zoneFilter: 'common',
            stateFilter: 'problem',
        });

        expect(views).toHaveLength(1);
        expect(views[0]?.id).toBe('워시타워_2');
    });

    it('문제 우선 정렬이 오류 기기를 앞에 둔다', () => {
        const {views} = filterAndSortLaundryMachineViews({
            ...filterInput,
            zoneFilter: 'all',
            stateFilter: 'all',
        });

        expect(views[0]?.id).toBe('워시타워_2');
        expect(views[0]?.dryer.tone === 'available' || views[0]?.washer.tone === 'error').toBe(
            true,
        );
    });
});

const NOW_MS = Date.parse('2026-08-11T03:00:00.000Z');

const baseMachine: DashboardLaundryMachine = {
    id: '워시타워_0',
    zone: 'men',
    washer: {
        appliance: 'washer',
        operationalStatus: 'IDLE',
        projection: {status: 'IDLE', remainingMinutes: 0},
    },
    dryer: {
        appliance: 'dryer',
        operationalStatus: 'IDLE',
        projection: {status: 'IDLE', remainingMinutes: 0},
    },
};

const baseSnapshot: DashboardLaundrySnapshot = {
    schemaVersion: 1,
    asOf: '2026-08-11T03:00:00.000Z',
    final: true,
    quality: {
        collectorHealthy: true,
        collection: 'SUCCESS',
        sourceFreshness: 'REFRESH_OBSERVED',
        lastCheckedAt: '2026-08-11T03:00:00.000Z',
        expectedRefreshIntervalSeconds: 30,
    },
    machines: [
        {
            ...baseMachine,
            id: '워시타워_1',
            zone: 'men',
            washer: {
                appliance: 'washer',
                operationalStatus: 'IDLE',
                projection: {status: 'IDLE', remainingMinutes: 0},
            },
            dryer: {
                appliance: 'dryer',
                operationalStatus: 'RUNNING',
                projection: {status: 'ESTIMATED_RUNNING', remainingMinutes: 20},
            },
        },
    ],
    capacity: {
        basis: 'WASHER_AND_DRYER_HEADROOM_60_MIN',
        men: {
            access: 'men',
            washerAvailable: 1,
            projectedDryerSupply: 1,
            pendingDryerLoads: 0,
            dryerHeadroom: 1,
            startableLoads: 1,
            reliable: true,
        },
        women: {
            access: 'women',
            washerAvailable: 1,
            projectedDryerSupply: 1,
            pendingDryerLoads: 0,
            dryerHeadroom: 1,
            startableLoads: 1,
            reliable: true,
        },
    },
};
