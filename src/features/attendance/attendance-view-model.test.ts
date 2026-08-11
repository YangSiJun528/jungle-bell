import {describe, expect, it} from 'vitest';
import type {AttendanceDashboard} from '@/dashboard-api';
import {
    attendanceDetailModel,
    attendancePreferencesEqual,
    attendanceSkipDate,
    deviceStatus,
} from './attendance-view-model';

const available: AttendanceDashboard = {
    state: 'loaded',
    attendance: {
        status: 'available',
        freshness: 'stale',
        lastSyncedAt: '2026-08-11T00:00:00.000Z',
        snapshot: {
            attendanceDate: '2026-08-11',
            cohortId: null,
            cohortStatus: 'active',
            cohortStartDate: null,
            cohortEndDate: null,
            morningChecked: true,
            eveningChecked: true,
            collectedAt: '2026-08-11T00:00:00.000Z',
        },
    },
    devices: [],
};

describe('attendanceDetailModel', () => {
    it('keeps stale freshness while reporting completed checks', () => {
        expect(attendanceDetailModel({isPending: false, isError: false, data: available})).toMatchObject({
            kind: 'available',
            freshness: 'stale',
        });
    });

    it('distinguishes authentication and first-sync states', () => {
        expect(attendanceDetailModel({
            isPending: false,
            isError: false,
            data: {state: 'auth-required'},
        }).kind).toBe('auth-required');
        expect(attendanceDetailModel({
            isPending: false,
            isError: false,
            data: {state: 'loaded', attendance: {status: 'unavailable', freshness: 'missing', lastSyncedAt: null, snapshot: null}, devices: []},
        }).kind).toBe('unavailable');
    });
});

describe('attendance preference helpers', () => {
    const preferences = {morning: true, evening: false, skipSunday: true, skipAttendanceDate: null};

    it('compares every server-backed setting', () => {
        expect(attendancePreferencesEqual(preferences, {...preferences})).toBe(true);
        expect(attendancePreferencesEqual(preferences, {...preferences, evening: true})).toBe(false);
        expect(attendancePreferencesEqual(null, preferences)).toBe(false);
    });

    it('only writes a validated current attendance date when enabled', () => {
        expect(attendanceSkipDate(true, '2026-08-11')).toBe('2026-08-11');
        expect(attendanceSkipDate(false, '2026-08-11')).toBeNull();
        expect(attendanceSkipDate(true, null)).toBeNull();
    });
});

it('summarizes the connected PC state', () => {
    expect(deviceStatus({
        id: 'pc', deviceLabel: '내 PC', lastSeenAt: null, health: 'online',
        lmsSessionState: 'connected', appVersion: null,
    })).toEqual({label: '정상 연결'});
});
