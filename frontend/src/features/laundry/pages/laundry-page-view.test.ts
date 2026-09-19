import {describe, expect, it} from 'vitest';

import type {DashboardLaundrySnapshot} from '@/api/dashboard-api';
import type {DashboardLaundryMachine, LaundryCapacitySnapshot} from '@/domain/laundry/capacity';

import {
    capacityCards,
    laundryPageState,
    laundrySourceObservedAt,
    laundrySummaryFromSnapshot,
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

    it('최근 수집에 성공했어도 원본 변화 미관측을 수집 지연으로 표시하지 않는다', () => {
        const snapshot: DashboardLaundrySnapshot = {
            ...baseSnapshot,
            asOf: '2026-09-19T20:13:30Z',
            quality: {
                ...baseSnapshot.quality,
                lastCheckedAt: '2026-09-19T20:13:06Z',
                sourceFreshness: 'REFRESH_OVERDUE',
                expectedRefreshIntervalSeconds: 300,
            },
        };
        const status = laundryPageState({
            snapshot,
            nowMs: Date.parse('2026-09-19T20:13:31Z'),
            queryError: null,
            manualRefreshError: null,
        });
        expect(status).toMatchObject({
            kind: 'stale',
            reason: 'source-overdue',
            allowWatchCreation: false,
            message: expect.stringContaining(
                '수집은 성공했지만 원본 내용의 변화가 관측되지 않았습니다.',
            ),
        });
        expect(status.message).not.toContain('수집이 지연');
        expect(laundrySummaryFromSnapshot({snapshot, nowMs: Date.parse(snapshot.asOf)})).toEqual({
            men: null,
            women: null,
        });
    });

    it('5분 미만 원본은 정상이며 로컬 만료와 시각 불일치는 별도 이유로 차단한다', () => {
        const snapshot: DashboardLaundrySnapshot = {
            ...baseSnapshot,
            quality: {
                ...baseSnapshot.quality,
                sourceFreshness: 'WITHIN_REFRESH_WINDOW',
                expectedRefreshIntervalSeconds: 300,
            },
        };
        const input = {snapshot, queryError: null, manualRefreshError: null};
        const savedAt = Date.parse(snapshot.asOf);
        expect(laundryPageState({...input, nowMs: savedAt - 3_545})).toMatchObject({
            kind: 'normal',
            allowWatchCreation: true,
        });
        expect(laundrySummaryFromSnapshot({snapshot, nowMs: savedAt - 3_545})).toEqual({
            men: 1,
            women: 1,
        });
        expect(
            laundryPageState({
                ...input,
                snapshot: {
                    ...snapshot,
                    quality: {...snapshot.quality, sourceFreshness: 'REFRESH_OVERDUE'},
                },
                nowMs: savedAt - 3_545,
            }),
        ).toMatchObject({kind: 'stale', reason: 'source-overdue', allowWatchCreation: false});
        expect(laundryPageState({...input, nowMs: savedAt + 299_000})).toMatchObject({
            kind: 'normal',
            allowWatchCreation: true,
        });
        expect(laundryPageState({...input, nowMs: savedAt + 600_001})).toMatchObject({
            kind: 'stale',
            reason: 'snapshot-unreliable',
            allowWatchCreation: false,
        });
        expect(laundryPageState({...input, nowMs: savedAt - 60_001})).toMatchObject({
            kind: 'stale',
            reason: 'snapshot-unreliable',
            allowWatchCreation: false,
        });
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

describe('laundrySourceObservedAt', () => {
    it('최근 수집 확인과 별개로 기기 원본 내용의 첫 관측 시각을 사용한다', () => {
        const observedAt = '2026-09-19T19:57:41Z';
        expect(
            laundrySourceObservedAt({
                ...baseSnapshot,
                machines: [{...baseMachine, washer: {...baseMachine.washer!, observedAt}}],
                quality: {...baseSnapshot.quality, lastCheckedAt: '2026-09-19T20:13:06Z'},
            }),
        ).toBe(observedAt);
        expect(laundrySourceObservedAt(baseSnapshot)).toBeNull();
    });

    it('누락되거나 잘못된 관측 시각은 수집 확인 시각으로 대체하지 않는다', () => {
        expect(
            laundrySourceObservedAt({
                ...baseSnapshot,
                machines: [
                    {...baseMachine, washer: {...baseMachine.washer!, observedAt: 'invalid'}},
                ],
            }),
        ).toBeNull();
        expect(
            laundryPageState({
                snapshot: {
                    ...baseSnapshot,
                    quality: {...baseSnapshot.quality, lastCheckedAt: null},
                },
                queryError: null,
                manualRefreshError: null,
            }).lastKnownAt,
        ).toBeNull();
    });
});
