import {QueryClient} from '@tanstack/react-query';
import {expect, test} from 'vitest';
import type {AttendanceDashboard} from '@/api/dashboard-api';
import {
    handleAttendanceSnapshotUpdated,
    preferDesktopAttendance,
} from './desktop-attendance-event';
import {queryKeys} from './dashboard-context';

test('업로드 완료 이벤트는 데스크톱 출석 캐시만 stale 처리한다', async () => {
    const client = new QueryClient();
    client.setQueryData(queryKeys.attendance('desktop'), {cohortId: 'old'});
    client.setQueryData(queryKeys.attendance('browser'), {cohortId: 'companion'});

    await handleAttendanceSnapshotUpdated(client, {kind: 'synced', revision: 1});

    expect(client.getQueryState(queryKeys.attendance('desktop'))?.isInvalidated).toBe(true);
    expect(client.getQueryState(queryKeys.attendance('browser'))?.isInvalidated).toBe(false);
});

test('잘못된 업로드 이벤트는 출석 캐시를 갱신하지 않는다', async () => {
    const client = new QueryClient();
    client.setQueryData(queryKeys.attendance('desktop'), {cohortId: 'old'});

    await handleAttendanceSnapshotUpdated(client, {kind: 'synced', revision: 0});

    expect(client.getQueryState(queryKeys.attendance('desktop'))?.isInvalidated).toBe(false);
});

const localSnapshot = {
    attendanceDate: '2026-08-19',
    cohortId: 'cohort-1',
    cohortStatus: 'active',
    cohortStartDate: '2026-08-01',
    cohortEndDate: '2026-08-31',
    morningChecked: true,
    eveningChecked: false,
    collectedAt: '2026-08-19T16:13:00.000Z',
};

test('로컬 checker 관측은 서버 왕복 전에 데스크톱 출석 캐시에 반영한다', async () => {
    const client = new QueryClient();
    const devices = [{id: 'desktop-1'}];
    client.setQueryData(queryKeys.attendance('desktop'), {
        state: 'loaded',
        attendance: {status: 'unavailable', freshness: 'missing', lastSyncedAt: null, snapshot: null},
        devices,
    });

    await handleAttendanceSnapshotUpdated(client, {kind: 'observed', snapshot: localSnapshot});

    expect(client.getQueryData(queryKeys.attendance('desktop'))).toEqual({
        state: 'loaded',
        attendance: {
            status: 'available',
            freshness: 'fresh',
            lastSyncedAt: localSnapshot.collectedAt,
            snapshot: localSnapshot,
            source: 'desktop',
            syncState: 'pending',
        },
        devices,
    });
});

test('늦게 도착한 로컬 관측은 더 새로운 출석 캐시를 되돌리지 않는다', async () => {
    const client = new QueryClient();
    const newer = {
        ...localSnapshot,
        collectedAt: '2026-08-19T16:20:00.000Z',
    };
    const current: AttendanceDashboard = {
        state: 'loaded',
        attendance: {
            status: 'available',
            freshness: 'fresh',
            lastSyncedAt: newer.collectedAt,
            snapshot: newer,
            source: 'server',
            syncState: 'synced',
        },
        devices: [],
    };
    client.setQueryData(queryKeys.attendance('desktop'), current);

    await handleAttendanceSnapshotUpdated(client, {kind: 'observed', snapshot: localSnapshot});

    expect(client.getQueryData(queryKeys.attendance('desktop'))).toBe(current);
});

test('서버 재조회가 더 오래된 경우 방금 관측한 PC 상태를 덮어쓰지 않는다', () => {
    const local: AttendanceDashboard = {
        state: 'loaded',
        attendance: {
            status: 'available',
            freshness: 'fresh',
            lastSyncedAt: localSnapshot.collectedAt,
            snapshot: localSnapshot,
            source: 'desktop',
            syncState: 'pending',
        },
        devices: [],
    };
    const server: AttendanceDashboard = {
        state: 'loaded',
        attendance: {
            status: 'available',
            freshness: 'stale',
            lastSyncedAt: '2026-08-19T15:50:00.000Z',
            snapshot: {...localSnapshot, collectedAt: '2026-08-19T15:50:00.000Z'},
        },
        devices: [],
    };

    expect(preferDesktopAttendance(local, server, Date.parse('2026-08-19T16:14:00.000Z'))).toBe(local);
    expect(preferDesktopAttendance(local, server, Date.parse('2026-08-19T16:29:00.001Z'))).toBe(server);
});

test('서버에 같은 시각의 snapshot이 도착하면 동기화 완료 응답을 사용한다', () => {
    const local: AttendanceDashboard = {
        state: 'loaded',
        attendance: {
            status: 'available',
            freshness: 'fresh',
            lastSyncedAt: localSnapshot.collectedAt,
            snapshot: localSnapshot,
            source: 'desktop',
            syncState: 'pending',
        },
        devices: [],
    };
    const server: AttendanceDashboard = {
        state: 'loaded',
        attendance: {
            status: 'available',
            freshness: 'fresh',
            lastSyncedAt: localSnapshot.collectedAt,
            snapshot: localSnapshot,
        },
        devices: [],
    };

    expect(preferDesktopAttendance(local, server, Date.parse('2026-08-19T16:14:00.000Z'))).toBe(server);
});
