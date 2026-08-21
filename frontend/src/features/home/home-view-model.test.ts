import {readFileSync} from 'node:fs';

import {describe, expect, it} from 'vitest';

import type {AttendanceDashboard, DashboardMealsSnapshot} from '@/api/dashboard-api';

import {
    homeAttendanceState,
    homeTodayMealSlots,
    homeTodayMeals,
    mealPeriodLabel,
} from './home-view-model';

const attendanceDashboard = (
    attendanceDate: string,
    freshness: 'fresh' | 'stale',
): AttendanceDashboard => ({
    state: 'loaded',
    devices: [],
    attendance: {
        status: 'available',
        freshness,
        lastSyncedAt: '2026-08-11T03:00:00.000Z',
        snapshot: {
            attendanceDate,
            cohortId: 'cohort',
            cohortStatus: 'active',
            cohortStartDate: '2026-08-01',
            cohortEndDate: '2026-08-31',
            morningChecked: true,
            eveningChecked: false,
            collectedAt: '2026-08-11T03:00:00.000Z',
        },
    },
});

describe('home feature boundaries', () => {
    it('keeps the global notification utility out of the home summary', () => {
        const source = readFileSync(new URL('./home-page.tsx', import.meta.url), 'utf8');
        const viewModelSource = readFileSync(
            new URL('./home-view-model.ts', import.meta.url),
            'utf8',
        );

        expect(source).not.toContain('useNotificationsQuery');
        expect(source).not.toContain('homeUnreadSummary');
        expect(source).not.toContain('seen-mobile-notifications');
        expect(source).not.toContain('href="#notifications"');
        expect(source).not.toContain('title="알림"');
        expect(source).not.toContain('useCampusDataIssue');
        expect(source).toContain('useSuspenseCampusQueries');
        expect(source).toContain('const laundryRefreshFailed = laundry.isError');
        expect(source).toContain(
            'const laundryCollectorUnavailable = !laundry.data.quality.collectorHealthy',
        );
        expect(viewModelSource).toMatch(
            /const locallyReliable\s*=\s*snapshot\.quality\.collectorHealthy/u,
        );
        expect(source).toContain('const mealsRefreshFailed = meals.isError');
        expect(source).toContain('수집 서버 장애로 마지막 정상 상태를 표시합니다.');
        expect(source).not.toContain('CardLoading');
        expect(source).not.toContain('CompactError');
    });

    it('PC와 설치형 PWA에는 출석 요약을, 일반 웹에는 앱 소개를 표시한다', () => {
        const source = readFileSync(new URL('./home-page.tsx', import.meta.url), 'utf8');

        expect(source).toContain("platform.kind === 'desktop' || platform.pwa.installed");
        expect(source).toContain('<JungleCampusSummary />');
        expect(source).toContain('<AppShowcaseCard />');
        expect(source.indexOf('<JungleCampusSummary')).toBeLessThan(
            source.lastIndexOf('<AsyncBoundary'),
        );
        expect(source).not.toContain('title="출석"');
        expect(source).not.toContain('<CardTitle>공식 정글캠퍼스</CardTitle>');
    });

    it('centers compact living summaries and keeps their footer divider tight', () => {
        const source = readFileSync(new URL('./home-page.tsx', import.meta.url), 'utf8');

        expect(source).toContain("'min-h-60 gap-0 overflow-hidden py-0'");
        expect(source).toMatch(/CardContent className="[^"]*justify-center/u);
        expect(source).toMatch(/CardFooter className="[^"]*\[\.border-t\]:pt-1\.5/u);
        expect(source).toContain('<HomeMealSlotsList slots={todayMealSlots} />');
    });

    it('labels laundry capacity as people who can start now', () => {
        const source = readFileSync(new URL('./home-page.tsx', import.meta.url), 'utf8');

        expect(source).toContain('남성 가능');
        expect(source).toContain('여성 가능');
        expect(source).toContain("laundryZonePresentation('men').surfaceClassName");
        expect(source).toContain("laundryZonePresentation('women').surfaceClassName");
        expect(source.match(/지금 시작 가능/g)).toHaveLength(2);
        expect(source).not.toContain('남성 세탁실');
        expect(source).not.toContain('여성 세탁실');
    });
});

describe('home meal summaries', () => {
    it('uses the shared meal date selector and keeps meal order', () => {
        const snapshot = {
            asOf: '2026-08-11T03:00:00.000Z',
            lastCheckedAt: '2026-08-11T03:00:00.000Z',
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
                    {
                        id: 'lunch',
                        title: '8월 11일 중식',
                        text: '점심',
                        publishedAt: null,
                        permalink: null,
                    },
                ],
                pinnedMenus: [
                    {
                        id: 'pinned',
                        title: '8월 2주차 식단표',
                        text: '고정',
                        publishedAt: null,
                        permalink: null,
                    },
                ],
                recentMenus: [],
                currentWeeklyMenu: null,
                weeklyMenus: [],
            },
        } satisfies DashboardMealsSnapshot;
        const today = homeTodayMeals(snapshot, new Date('2026-08-11T03:00:00.000Z'));
        expect(today.map(({id}) => id)).toEqual(['lunch', 'dinner']);
        expect(mealPeriodLabel(today[0]!)).toBe('중식');
        expect(mealPeriodLabel({title: '8월 11일 조식'})).toBe('조식');
    });

    it('does not show yesterday daily data or a pinned weekly post as today meals', () => {
        const snapshot = {
            asOf: '2026-08-11T03:00:00.000Z',
            lastCheckedAt: '2026-08-11T03:00:00.000Z',
            data: {
                schemaVersion: 2,
                dailyMenus: [
                    {
                        id: 'yesterday',
                        title: '8월 10일 중식',
                        text: '어제 메뉴',
                        publishedAt: '2026-08-10T02:00:00.000Z',
                        permalink: null,
                    },
                ],
                pinnedMenus: [
                    {
                        id: 'weekly',
                        title: '8월 2주차 식단표',
                        text: '주간표',
                        publishedAt: '2026-08-10T00:00:00.000Z',
                        permalink: null,
                    },
                ],
                recentMenus: [],
                currentWeeklyMenu: null,
                weeklyMenus: [],
            },
        } satisfies DashboardMealsSnapshot;

        expect(homeTodayMeals(snapshot, new Date('2026-08-11T03:00:00.000Z'))).toEqual([]);
    });

    it('keeps lunch and dinner in fixed slots while excluding breakfast', () => {
        const snapshot = mealsSnapshot([
            meal('dinner', '8월 11일 석식', '저녁'),
            meal('breakfast', '8월 11일 조식', '아침'),
            meal('lunch', '8월 11일 중식', '점심'),
        ]);

        expect(homeTodayMealSlots(snapshot, new Date('2026-08-11T03:00:00.000Z'))).toEqual([
            {period: '중식', meal: meal('lunch', '8월 11일 중식', '점심')},
            {period: '석식', meal: meal('dinner', '8월 11일 석식', '저녁')},
        ]);
    });

    it('preserves an empty dinner slot when only lunch has been posted', () => {
        const snapshot = mealsSnapshot([meal('lunch', '8월 11일 중식', '점심')]);

        expect(homeTodayMealSlots(snapshot, new Date('2026-08-11T03:00:00.000Z'))).toEqual([
            {period: '중식', meal: meal('lunch', '8월 11일 중식', '점심')},
            {period: '석식', meal: null},
        ]);
    });

    it('preserves an empty lunch slot when only dinner has been posted', () => {
        const snapshot = mealsSnapshot([meal('dinner', '8월 11일 석식', '저녁')]);

        expect(homeTodayMealSlots(snapshot, new Date('2026-08-11T03:00:00.000Z'))).toEqual([
            {period: '중식', meal: null},
            {period: '석식', meal: meal('dinner', '8월 11일 석식', '저녁')},
        ]);
    });

    it('returns the empty-state signal when neither lunch nor dinner exists', () => {
        const reference = new Date('2026-08-11T03:00:00.000Z');

        expect(homeTodayMealSlots(mealsSnapshot([]), reference)).toBeNull();
        expect(
            homeTodayMealSlots(
                mealsSnapshot([meal('breakfast', '8월 11일 조식', '아침')]),
                reference,
            ),
        ).toBeNull();
    });
});

function meal(id: string, title: string, text: string) {
    return {id, title, text, publishedAt: null, permalink: null};
}

function mealsSnapshot(
    dailyMenus: DashboardMealsSnapshot['data']['dailyMenus'],
): DashboardMealsSnapshot {
    return {
        asOf: '2026-08-11T03:00:00.000Z',
        lastCheckedAt: '2026-08-11T03:00:00.000Z',
        data: {
            schemaVersion: 2,
            dailyMenus,
            pinnedMenus: [],
            recentMenus: [],
            currentWeeklyMenu: null,
            weeklyMenus: [],
        },
    };
}

describe('home attendance summary', () => {
    const reference = new Date('2026-08-11T03:00:00.000Z');

    it('shows checks only for a fresh snapshot whose KST date is today', () => {
        expect(
            homeAttendanceState(attendanceDashboard('2026-08-11', 'fresh'), reference),
        ).toMatchObject({kind: 'current', attendance: {status: 'available', freshness: 'fresh'}});
    });

    it('stale과 다른 출석일을 서로 다른 원인으로 분류한다', () => {
        expect(
            homeAttendanceState(attendanceDashboard('2026-08-11', 'stale'), reference).kind,
        ).toBe('stale');
        expect(
            homeAttendanceState(attendanceDashboard('2026-08-10', 'fresh'), reference).kind,
        ).toBe('different-attendance-day');
    });

    it('자정부터 04시 전까지 방금 수집한 전날 출석을 현재 출석일로 표시한다', () => {
        const beforeRollover = new Date('2026-08-19T16:13:00.000Z'); // KST 8월 20일 01:13

        expect(
            homeAttendanceState(attendanceDashboard('2026-08-19', 'fresh'), beforeRollover).kind,
        ).toBe('current');
    });

    it('04시부터는 전날 snapshot을 새 출석일 대기 상태로 분류한다', () => {
        const afterRollover = new Date('2026-08-19T19:00:00.000Z'); // KST 8월 20일 04:00

        expect(
            homeAttendanceState(attendanceDashboard('2026-08-19', 'fresh'), afterRollover).kind,
        ).toBe('different-attendance-day');
    });

    it('서버 응답이 없어도 PC 로컬 관측은 15분 동안만 fresh로 취급한다', () => {
        const local = attendanceDashboard('2026-08-20', 'fresh');
        if (local.state !== 'loaded' || local.attendance.status !== 'available')
            throw new Error('invalid fixture');
        local.attendance.source = 'desktop';
        local.attendance.syncState = 'pending';
        local.attendance.lastSyncedAt = '2026-08-19T20:00:00.000Z';
        local.attendance.snapshot.collectedAt = local.attendance.lastSyncedAt;

        expect(homeAttendanceState(local, new Date('2026-08-19T20:15:00.000Z')).kind).toBe(
            'current',
        );
        expect(homeAttendanceState(local, new Date('2026-08-19T20:15:00.001Z')).kind).toBe('stale');
    });
});
