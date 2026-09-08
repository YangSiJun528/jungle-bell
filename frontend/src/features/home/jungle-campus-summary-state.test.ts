import {describe, expect, it} from 'vitest';

import type {AttendanceDashboard} from '@/api/dashboard-api';

import {
    resolveCampusAccessState,
    resolveCampusAttendanceContentState,
    type BrowserAccessStatus,
    type DesktopAccessStatus,
} from './jungle-campus-summary-state';

const connectedAccountStatus = {
    lmsAuthentication: 'authenticated',
    serverSession: 'stored',
} as const;

describe('resolveCampusAccessState', () => {
    it.each(['not-applicable', 'checking', 'unconnected', 'error'] satisfies BrowserAccessStatus[])(
        '브라우저의 %s 상태를 출석 데이터보다 먼저 표시한다',
        (personalAccessStatus) => {
            expect(
                resolveCampusAccessState({
                    platformKind: 'browser',
                    desktopAccount: false,
                    desktopLocalAttendanceAvailable: false,
                    personalAccessStatus,
                    accountStatus: connectedAccountStatus,
                }),
            ).toEqual({kind: 'browser', status: personalAccessStatus});
        },
    );

    it.each([
        ['checking', 'lms-checking'],
        ['required', 'lms-required'],
        ['unavailable', 'lms-unavailable'],
    ] as const)(
        '데스크톱 LMS %s 상태를 로컬 출석보다 먼저 표시한다',
        (lmsAuthentication, expected) => {
            expect(
                resolveCampusAccessState({
                    platformKind: 'desktop',
                    desktopAccount: true,
                    desktopLocalAttendanceAvailable: true,
                    personalAccessStatus: 'connected',
                    accountStatus: {lmsAuthentication, serverSession: 'missing'},
                }),
            ).toEqual({kind: 'desktop', status: expected satisfies DesktopAccessStatus});
        },
    );

    it.each([
        ['checking', 'session-checking'],
        ['recovery-required', 'session-recovery-required'],
        ['missing', 'session-missing'],
    ] as const)('로컬 출석이 없으면 서버 세션 %s 상태를 표시한다', (serverSession, expected) => {
        expect(
            resolveCampusAccessState({
                platformKind: 'desktop',
                desktopAccount: true,
                desktopLocalAttendanceAvailable: false,
                personalAccessStatus: 'connected',
                accountStatus: {lmsAuthentication: 'authenticated', serverSession},
            }),
        ).toEqual({kind: 'desktop', status: expected satisfies DesktopAccessStatus});
    });

    it('로컬 출석이 있으면 누락된 서버 세션 대신 출석을 표시한다', () => {
        expect(
            resolveCampusAccessState({
                platformKind: 'desktop',
                desktopAccount: true,
                desktopLocalAttendanceAvailable: true,
                personalAccessStatus: 'connected',
                accountStatus: {lmsAuthentication: 'authenticated', serverSession: 'missing'},
            }),
        ).toEqual({kind: 'attendance'});
    });
});

const reference = new Date('2026-08-11T03:00:00.000Z');

function attendanceDashboard(
    attendanceDate = '2026-08-11',
    freshness: 'fresh' | 'stale' = 'fresh',
): AttendanceDashboard {
    return {
        state: 'loaded',
        devices: [],
        attendance: {
            status: 'available',
            freshness,
            lastSyncedAt: '2026-08-11T03:00:00.000Z',
            source: 'server',
            syncState: 'pending',
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
    };
}

describe('resolveCampusAttendanceContentState', () => {
    it('초기 로딩과 초기 오류를 캐시 없는 상태에서만 선택한다', () => {
        expect(
            resolveCampusAttendanceContentState({
                personalReady: true,
                isPending: true,
                isError: false,
                data: undefined,
                reference,
            }),
        ).toEqual({kind: 'loading'});
        expect(
            resolveCampusAttendanceContentState({
                personalReady: true,
                isPending: false,
                isError: true,
                data: undefined,
                reference,
            }),
        ).toEqual({kind: 'error'});
    });

    it('인증 필요와 아직 동기화되지 않은 상태를 구분한다', () => {
        expect(
            resolveCampusAttendanceContentState({
                personalReady: true,
                isPending: false,
                isError: false,
                data: {state: 'auth-required'},
                reference,
            }),
        ).toEqual({kind: 'authentication-required'});
        expect(
            resolveCampusAttendanceContentState({
                personalReady: true,
                isPending: false,
                isError: false,
                data: {
                    state: 'loaded',
                    devices: [],
                    attendance: {
                        status: 'unavailable',
                        freshness: 'missing',
                        lastSyncedAt: null,
                        snapshot: null,
                    },
                },
                reference,
            }),
        ).toEqual({kind: 'unavailable'});
    });

    it('오래됐거나 다른 출석일인 캐시를 각각의 복구 상태로 유지한다', () => {
        expect(
            resolveCampusAttendanceContentState({
                personalReady: true,
                isPending: false,
                isError: false,
                data: attendanceDashboard('2026-08-11', 'stale'),
                reference,
            }).kind,
        ).toBe('stale');
        expect(
            resolveCampusAttendanceContentState({
                personalReady: true,
                isPending: false,
                isError: false,
                data: attendanceDashboard('2026-08-10'),
                reference,
            }).kind,
        ).toBe('different-attendance-day');
    });

    it('백그라운드 재조회 실패 시 마지막 정상 출석과 실패 표식을 함께 보존한다', () => {
        const data = attendanceDashboard();

        expect(
            resolveCampusAttendanceContentState({
                personalReady: true,
                isPending: false,
                isError: true,
                data,
                reference,
            }),
        ).toEqual({
            kind: 'ready',
            attendance: data.state === 'loaded' ? data.attendance : null,
            refreshFailed: true,
        });
    });

    it('개인 접근이 준비되지 않으면 수신한 출석 상세를 노출하지 않는다', () => {
        expect(
            resolveCampusAttendanceContentState({
                personalReady: false,
                isPending: false,
                isError: false,
                data: attendanceDashboard(),
                reference,
            }),
        ).toEqual({kind: 'ready', attendance: null, refreshFailed: false});
    });
});
