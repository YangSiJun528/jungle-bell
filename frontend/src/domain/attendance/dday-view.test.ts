import {describe, expect, it} from 'vitest';

import type {AttendanceDashboard} from '@/api/dashboard-api';

import {selectDdayView} from './dday-view';

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

describe('selectDdayView', () => {
    it.each([
        ['stale', '2026-08-11'],
        ['fresh', '2026-08-10'],
    ] as const)(
        'uses valid cohort dates even when attendance is %s or from %s',
        (freshness, attendanceDate) => {
            const result = selectDdayView({
                platform: 'browser',
                attendance: attendanceDashboard({freshness, attendanceDate}),
                today: '2026-08-11',
            });

            expect(result?.text).toBe('수료까지 D-20');
            expect(result?.period).toEqual({
                startDate: '2026-08-01',
                endDate: '2026-08-31',
            });
            expect(result?.progress?.current).toBe(1);
        },
    );

    it('keeps existing browser labels for upcoming and ended cohorts', () => {
        expect(
            selectDdayView({
                platform: 'browser',
                attendance: attendanceDashboard({cohortStatus: 'upcoming'}),
                today: '2026-07-28',
            })?.text,
        ).toBe('시작까지 D-4');
        expect(
            selectDdayView({
                platform: 'browser',
                attendance: attendanceDashboard({cohortStatus: 'ended'}),
                today: '2026-09-01',
            })?.text,
        ).toBe('과정 종료');
    });

    it('hides unavailable and invalid personal D-Day data', () => {
        expect(
            selectDdayView({
                platform: 'browser',
                attendance: {state: 'auth-required'},
                today: '2026-08-11',
            }),
        ).toBeNull();
        expect(
            selectDdayView({
                platform: 'browser',
                attendance: attendanceDashboard({startDate: '2026-08-31', endDate: '2026-08-01'}),
                today: '2026-08-11',
            }),
        ).toBeNull();
    });
});
