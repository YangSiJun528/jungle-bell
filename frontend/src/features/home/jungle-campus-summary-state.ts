import type {AttendanceDashboard, AttendanceData} from '@/api/dashboard-api';
import type {DashboardAccountStatus, PersonalAccessStatus} from '@/app/dashboard-account-state';
import type {PlatformKind} from '@/platform/contracts';

import {homeAttendanceState} from './home-view-model';

type AvailableAttendance = Extract<AttendanceData, {status: 'available'}>;

export type BrowserAccessStatus = Exclude<PersonalAccessStatus, 'connected'>;

export type DesktopAccessStatus =
    | 'lms-checking'
    | 'lms-required'
    | 'lms-unavailable'
    | 'session-checking'
    | 'session-recovery-required'
    | 'session-missing';

export type CampusAccessState =
    | {kind: 'browser'; status: BrowserAccessStatus}
    | {kind: 'desktop'; status: DesktopAccessStatus}
    | {kind: 'attendance'};

interface CampusAccessStateInput {
    platformKind: PlatformKind;
    desktopAccount: boolean;
    desktopLocalAttendanceAvailable: boolean;
    personalAccessStatus: PersonalAccessStatus;
    accountStatus: DashboardAccountStatus;
}

export function resolveCampusAccessState({
    platformKind,
    desktopAccount,
    desktopLocalAttendanceAvailable,
    personalAccessStatus,
    accountStatus,
}: CampusAccessStateInput): CampusAccessState {
    if (platformKind === 'browser' && personalAccessStatus !== 'connected') {
        return {kind: 'browser', status: personalAccessStatus};
    }
    if (!desktopAccount) return {kind: 'attendance'};

    if (accountStatus.lmsAuthentication === 'checking') {
        return {kind: 'desktop', status: 'lms-checking'};
    }
    if (accountStatus.lmsAuthentication === 'required') {
        return {kind: 'desktop', status: 'lms-required'};
    }
    if (accountStatus.lmsAuthentication === 'unavailable') {
        return {kind: 'desktop', status: 'lms-unavailable'};
    }
    if (desktopLocalAttendanceAvailable) return {kind: 'attendance'};

    if (accountStatus.serverSession === 'checking') {
        return {kind: 'desktop', status: 'session-checking'};
    }
    if (accountStatus.serverSession === 'recovery-required') {
        return {kind: 'desktop', status: 'session-recovery-required'};
    }
    if (accountStatus.serverSession === 'missing') {
        return {kind: 'desktop', status: 'session-missing'};
    }
    return {kind: 'attendance'};
}

export type CampusAttendanceContentState =
    | {kind: 'loading'}
    | {kind: 'error'}
    | {kind: 'authentication-required'}
    | {kind: 'unavailable'}
    | {kind: 'stale'; attendance: AvailableAttendance}
    | {kind: 'different-attendance-day'; attendance: AvailableAttendance}
    | {
          kind: 'ready';
          attendance: AvailableAttendance | null;
          refreshFailed: boolean;
      };

interface CampusAttendanceContentStateInput {
    personalReady: boolean;
    isPending: boolean;
    isError: boolean;
    data: AttendanceDashboard | undefined;
    reference?: Date;
}

export function resolveCampusAttendanceContentState({
    personalReady,
    isPending,
    isError,
    data,
    reference = new Date(),
}: CampusAttendanceContentStateInput): CampusAttendanceContentState {
    const attendanceState = personalReady
        ? homeAttendanceState(data, reference)
        : ({kind: 'unavailable'} as const);

    if (isPending && !data) return {kind: 'loading'};
    if (isError && !data) return {kind: 'error'};
    if (data?.state === 'auth-required') return {kind: 'authentication-required'};
    if (data?.state === 'loaded' && data.attendance.status === 'unavailable') {
        return {kind: 'unavailable'};
    }
    if (attendanceState.kind === 'stale') return attendanceState;
    if (attendanceState.kind === 'different-attendance-day') return attendanceState;
    return {
        kind: 'ready',
        attendance: attendanceState.kind === 'current' ? attendanceState.attendance : null,
        refreshFailed: isError && data !== undefined,
    };
}
