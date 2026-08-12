import {describe, expect, it} from 'vitest';
import type {
    AttendanceDashboard,
    DashboardHomeOverview,
} from '@/api/dashboard-api';
import {selectHomeDday} from './home-dday';

function attendanceDashboard({
    attendanceDate = '2026-08-11',
    freshness = 'fresh',
    startDate = '2026-08-01',
    endDate = '2026-08-31',
    cohortStatus = 'active',
}: {
    attendanceDate?: string;
    freshness?: 'fresh' | 'stale';
    startDate?: string | null;
    endDate?: string | null;
    cohortStatus?: string;
} = {}): AttendanceDashboard {
    return {
        state: 'loaded',
        devices: [],
        attendance: {
            status: 'available',
            freshness,
            lastSyncedAt: '2026-08-11T03:00:00.000Z',
            snapshot: {
                attendanceDate,
                cohortId: 'cohort',
                cohortStatus,
                cohortStartDate: startDate,
                cohortEndDate: endDate,
                morningChecked: true,
                eveningChecked: false,
                collectedAt: '2026-08-11T03:00:00.000Z',
            },
        },
    };
}

function overview(
    ddayText: string | null,
    ddayPeriod: {startDate: string; endDate: string} | null,
): DashboardHomeOverview {
    return {
        attendance: {
            status: 'active',
            statusText: '출석 확인',
            ddayText,
            ddayPeriod,
            currentVersion: '0.5.0',
        },
        lmsSessionState: 'connected',
        unreadCount: 0,
        laundry: null,
        meals: null,
    };
}

describe('selectHomeDday', () => {
    it('prefers the desktop overview text and period over personal attendance', () => {
        const result = selectHomeDday({
            surface: 'desktop',
            overview: overview('수료까지 D-142', {
                startDate: '2026-08-01',
                endDate: '2026-12-31',
            }),
            attendance: attendanceDashboard({
                startDate: '2026-07-01',
                endDate: '2026-08-31',
            }),
            today: '2026-08-11',
        });

        expect(result?.text).toBe('수료까지 D-142');
        expect(result?.period).toEqual({
            startDate: '2026-08-01',
            endDate: '2026-12-31',
        });
        expect(result?.progress?.total).toBe(153);
    });

    it.each([
        ['stale', '2026-08-11'],
        ['fresh', '2026-08-10'],
    ] as const)('uses valid cohort dates even when attendance is %s or from %s', (freshness, attendanceDate) => {
        const result = selectHomeDday({
            surface: 'companion',
            attendance: attendanceDashboard({freshness, attendanceDate}),
            today: '2026-08-11',
        });

        expect(result?.text).toBe('수료까지 D-20');
        expect(result?.period).toEqual({
            startDate: '2026-08-01',
            endDate: '2026-08-31',
        });
        expect(result?.progress?.current).toBe(1);
    });

    it('keeps a desktop text-only D-Day state without inventing a period', () => {
        const result = selectHomeDday({
            surface: 'desktop',
            overview: overview('수료일 정보 없음', null),
            attendance: {state: 'auth-required'},
            today: '2026-08-11',
        });

        expect(result).toEqual({
            text: '수료일 정보 없음',
            period: null,
            progress: null,
        });
    });

    it('shows a valid period with a neutral label even if no text source exists', () => {
        const result = selectHomeDday({
            surface: 'desktop',
            overview: overview(null, {
                startDate: '2026-08-01',
                endDate: '2026-08-31',
            }),
            attendance: {state: 'auth-required'},
            today: '2026-08-11',
        });

        expect(result?.text).toBe('과정 일정 확인 중');
        expect(result?.progress?.percent).toBe(32.3);
    });

    it('keeps existing companion labels for upcoming and ended cohorts', () => {
        expect(selectHomeDday({
            surface: 'companion',
            attendance: attendanceDashboard({cohortStatus: 'upcoming'}),
            today: '2026-07-28',
        })?.text).toBe('시작까지 D-4');
        expect(selectHomeDday({
            surface: 'companion',
            attendance: attendanceDashboard({cohortStatus: 'ended'}),
            today: '2026-09-01',
        })?.text).toBe('과정 종료');
    });

    it('hides public, unavailable, and invalid personal D-Day data', () => {
        expect(selectHomeDday({
            surface: 'public',
            overview: overview('수료까지 D-20', {
                startDate: '2026-08-01',
                endDate: '2026-08-31',
            }),
            attendance: attendanceDashboard(),
            today: '2026-08-11',
        })).toBeNull();
        expect(selectHomeDday({
            surface: 'companion',
            attendance: {state: 'auth-required'},
            today: '2026-08-11',
        })).toBeNull();
        expect(selectHomeDday({
            surface: 'companion',
            attendance: attendanceDashboard({startDate: '2026-08-31', endDate: '2026-08-01'}),
            today: '2026-08-11',
        })).toBeNull();
    });
});
