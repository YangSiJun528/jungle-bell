import type {AttendanceDashboard, AttendanceSnapshot, DesktopDevice} from '@/api/dashboard-api';
import type {AttendancePreferences} from '@/api/personal-api';
import {ATTENDANCE_FRESHNESS_MS} from '@/domain/attendance/freshness';

export type AttendanceDetailModel =
    | {kind: 'loading'}
    | {kind: 'error'}
    | {kind: 'auth-required'}
    | {kind: 'unavailable'}
    | {
          kind: 'available';
          freshness: 'fresh' | 'stale';
          lastSyncedAt: string;
          snapshot: AttendanceSnapshot;
          source?: 'server' | 'desktop';
          syncState?: 'synced' | 'pending';
      };

export function attendanceDetailModel(input: {
    isPending: boolean;
    isError: boolean;
    data?: AttendanceDashboard;
    now?: number;
}): AttendanceDetailModel {
    if (input.isError) return {kind: 'error'};
    if (input.isPending || !input.data) return {kind: 'loading'};
    if (input.data.state === 'auth-required') {
        return {kind: 'auth-required'};
    }
    if (input.data.attendance.status === 'unavailable') {
        return {kind: 'unavailable'};
    }
    const attendance = input.data.attendance;
    const localObservationExpired =
        attendance.source === 'desktop' &&
        (input.now ?? Date.now()) - Date.parse(attendance.lastSyncedAt) > ATTENDANCE_FRESHNESS_MS;
    return {
        kind: 'available',
        freshness: attendance.freshness === 'stale' || localObservationExpired ? 'stale' : 'fresh',
        lastSyncedAt: attendance.lastSyncedAt,
        snapshot: attendance.snapshot,
        source: attendance.source,
        syncState: attendance.syncState,
    };
}

export function attendancePreferencesEqual(
    left: AttendancePreferences | null,
    right: AttendancePreferences | null,
): boolean {
    return (
        left !== null &&
        right !== null &&
        left.enabled === right.enabled &&
        left.morning === right.morning &&
        left.evening === right.evening &&
        left.morningStartHour === right.morningStartHour &&
        left.eveningEndHour === right.eveningEndHour &&
        left.morningIntervalMinutes === right.morningIntervalMinutes &&
        left.eveningIntervalMinutes === right.eveningIntervalMinutes &&
        left.skipSunday === right.skipSunday &&
        left.skipAttendanceDate === right.skipAttendanceDate
    );
}

export function attendanceSkipDate(checked: boolean, attendanceDate: string | null): string | null {
    return checked ? attendanceDate : null;
}

export function deviceStatus(device: DesktopDevice): {label: string} {
    if (device.health === 'offline') return {label: '오프라인'};
    if (device.lmsSessionState === 'login-required') return {label: 'LMS 로그인 필요'};
    if (device.health === 'online' && device.lmsSessionState === 'connected') {
        return {label: '정상 연결'};
    }
    return {label: '확인 중'};
}
