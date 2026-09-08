import {describe, expect, it} from 'vitest';

import type {DashboardMealsSnapshot} from '@/api/dashboard-api';

import {
    mealsGroupedByDate,
    mealsPageLoadState,
    type MealsPageLoadInput,
    todayMealSlots,
    weekKeyForDate,
    weekRangeLabel,
    weeklyMenuForDate,
} from './meal-view';

const snapshot: DashboardMealsSnapshot = {
    asOf: '2026-08-11T00:00:00.000Z',
    lastCheckedAt: null,
    data: {
        schemaVersion: 2,
        dailyMenus: [
            {
                id: 'dinner',
                title: '8월 11일 석식',
                text: '저녁',
                publishedAt: null,
                permalink: null,
            },
            {id: 'lunch', title: '8월 11일 중식', text: '점심', publishedAt: null, permalink: null},
        ],
        pinnedMenus: [],
        recentMenus: [
            {id: 'lunch', title: '중복', text: '중복', publishedAt: null, permalink: null},
            {id: 'older', title: '8월 10일 중식', text: '이전', publishedAt: null, permalink: null},
        ],
        currentWeeklyMenu: null,
        weeklyMenus: [],
    },
};

describe('todayMealSlots', () => {
    it('중식과 석식 슬롯을 고정하고 게시되지 않은 식사는 빈 슬롯으로 둔다', () => {
        const slots = todayMealSlots([snapshot.data.dailyMenus[1]!]);

        expect(slots.map(({period, meal}) => [period, meal?.id ?? null])).toEqual([
            ['중식', 'lunch'],
            ['석식', null],
        ]);
    });
});

describe('급식 이력 보조 모델', () => {
    it('급식 기록을 날짜별로 묶고 식사 순서로 정렬한다', () => {
        const grouped = mealsGroupedByDate(
            snapshot.data.dailyMenus,
            new Date('2026-08-11T03:00:00.000Z'),
        );
        expect(grouped.get('2026-08-11')?.map((meal) => meal.id)).toEqual(['lunch', 'dinner']);
    });

    it('주간 식단의 월요일부터 일요일까지를 표시한다', () => {
        expect(weekRangeLabel('2026-08-10')).toBe('8월 10일 ~ 8월 16일');
    });

    it('선택한 날짜가 속한 월요일 주차의 저장된 급식표를 찾는다', () => {
        const weekly = [
            {
                weekKey: '2026-08-10',
                contentSha: 'weekly-sha',
                post: {
                    id: 'weekly',
                    title: '8월 2주차 식단표',
                    text: '',
                    publishedAt: '2026-08-10T00:00:00.000Z',
                    permalink: null,
                },
            },
            {
                weekKey: '2026-08-17',
                contentSha: 'next-week-sha',
                post: {
                    id: 'next-weekly',
                    title: '8월 3주차 식단표',
                    text: '',
                    publishedAt: '2026-08-17T00:00:00.000Z',
                    permalink: null,
                },
            },
        ];

        expect(weekKeyForDate('2026-08-16')).toBe('2026-08-10');
        expect(weeklyMenuForDate(weekly, '2026-08-13')?.post.id).toBe('weekly');
        expect(weeklyMenuForDate(weekly, '2026-08-18')?.post.id).toBe('next-weekly');
        expect(weeklyMenuForDate(weekly, '2026-08-24')).toBeNull();
    });
});

describe('Meals 페이지 상태 모델', () => {
    const fixture = (patch: Partial<MealsPageLoadInput>): MealsPageLoadInput => ({
        hasData: true,
        isPending: false,
        isStale: false,
        isError: false,
        manualRefreshError: false,
        todayHasContent: true,
        weeklyHasContent: true,
        historyHasContent: true,
        isOffline: false,
        ...patch,
    });

    it('로딩은 데이터가 없고 pending일 때만 loading으로 분류한다', () => {
        expect(
            mealsPageLoadState(
                fixture({
                    hasData: false,
                    isPending: true,
                    isError: false,
                }),
            ).kind,
        ).toBe('loading');
    });

    it('데이터가 없으면 오프라인을 로딩보다 우선하고 정상 응답의 빈값을 구분한다', () => {
        expect(
            mealsPageLoadState(
                fixture({
                    hasData: false,
                    isPending: true,
                    isOffline: true,
                }),
            ),
        ).toMatchObject({kind: 'offline', reason: 'offline', canRetry: false});

        expect(
            mealsPageLoadState(
                fixture({
                    hasData: false,
                    isPending: false,
                }),
            ),
        ).toMatchObject({kind: 'empty', reason: null, hasFailure: false});
    });

    it('데이터 갱신 실패는 stale와 recovered를 구분한다', () => {
        const stale = mealsPageLoadState(
            fixture({
                isError: true,
                isStale: true,
                previous: {
                    kind: 'normal',
                    hasFailure: false,
                    reason: null,
                    hasRecovered: false,
                    canRetry: false,
                    sections: {
                        todayEmpty: false,
                        weeklyEmpty: false,
                        historyEmpty: false,
                    },
                },
            }),
        );

        expect(stale.kind).toBe('stale');
        expect(stale.reason).toBe('fetch-failed');
        expect(stale.canRetry).toBe(true);

        const aged = mealsPageLoadState(fixture({isStale: true}));
        expect(aged.kind).toBe('stale');
        expect(aged.canRetry).toBe(true);

        const recovered = mealsPageLoadState(
            fixture({
                previous: {
                    kind: 'stale',
                    hasFailure: true,
                    reason: 'fetch-failed',
                    hasRecovered: false,
                    canRetry: true,
                    sections: {
                        todayEmpty: false,
                        weeklyEmpty: false,
                        historyEmpty: false,
                    },
                },
            }),
        );

        expect(recovered.kind).toBe('recovered');
        expect(recovered.hasRecovered).toBe(true);
        expect(recovered.canRetry).toBe(false);
    });

    it('장애 이력 없는 수동 새로고침 성공은 recovered로 오인하지 않는다', () => {
        expect(mealsPageLoadState(fixture({recovered: false})).kind).toBe('normal');
    });

    it('오프라인/빈값/오류/재확보를 분명히 구분한다', () => {
        const offline = mealsPageLoadState(
            fixture({
                isOffline: true,
            }),
        );
        expect(offline.kind).toBe('offline');
        expect(offline.reason).toBe('offline');
        expect(offline.canRetry).toBe(false);

        const empty = mealsPageLoadState(
            fixture({
                todayHasContent: false,
                weeklyHasContent: false,
                historyHasContent: false,
            }),
        );
        expect(empty.kind).toBe('empty');
        expect(empty.sections).toEqual({
            todayEmpty: true,
            weeklyEmpty: true,
            historyEmpty: true,
        });

        const error = mealsPageLoadState(
            fixture({
                hasData: false,
                isPending: false,
                isError: true,
                isOffline: false,
            }),
        );
        expect(error.kind).toBe('error');
        expect(error.canRetry).toBe(true);

        const recovered = mealsPageLoadState(
            fixture({
                previous: {
                    kind: 'error',
                    hasFailure: true,
                    reason: 'fetch-failed',
                    hasRecovered: false,
                    canRetry: true,
                    sections: {
                        todayEmpty: false,
                        weeklyEmpty: false,
                        historyEmpty: false,
                    },
                },
            }),
        );
        expect(recovered.kind).toBe('recovered');
        expect(recovered.reason).toBe(null);
    });

    it('섹션별 빈값 플래그는 UI 메시지 라우팅에 사용 가능하다', () => {
        const mixed = mealsPageLoadState(
            fixture({
                todayHasContent: false,
                weeklyHasContent: true,
                historyHasContent: false,
            }),
        );

        expect(mixed.kind).toBe('normal');
        expect(mixed.sections).toEqual({
            todayEmpty: true,
            weeklyEmpty: false,
            historyEmpty: true,
        });
    });
});
