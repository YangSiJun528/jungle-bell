import type {QueryClient} from '@tanstack/react-query';
import type {
    AttendanceDashboard,
    AttendanceSnapshot,
} from '@/api/dashboard-api';
import {ATTENDANCE_FRESHNESS_MS} from '@/domain/attendance/freshness';
import {parseAttendanceSnapshotEvent} from '@/platform/attendance-snapshot-event';
import {queryKeys} from './dashboard-context';

function dashboardWithLocalObservation(
    current: AttendanceDashboard | undefined,
    snapshot: AttendanceSnapshot,
): AttendanceDashboard {
    if (current?.state === 'loaded' && current.attendance.status === 'available') {
        const currentCollectedAt = Date.parse(current.attendance.lastSyncedAt);
        const observedAt = Date.parse(snapshot.collectedAt);
        if (Number.isFinite(currentCollectedAt)
            && Number.isFinite(observedAt)
            && currentCollectedAt >= observedAt) {
            return current;
        }
    }
    return {
        state: 'loaded',
        attendance: {
            status: 'available',
            freshness: 'fresh',
            lastSyncedAt: snapshot.collectedAt,
            snapshot,
            source: 'desktop',
            syncState: 'pending',
        },
        devices: current?.state === 'loaded' ? current.devices : [],
    };
}

export function preferDesktopAttendance(
    current: AttendanceDashboard | undefined,
    fetched: AttendanceDashboard,
    now = Date.now(),
): AttendanceDashboard {
    if (current?.state !== 'loaded'
        || current.attendance.status !== 'available'
        || current.attendance.source !== 'desktop'
        || current.attendance.syncState !== 'pending') {
        return fetched;
    }

    const localCollectedAt = Date.parse(current.attendance.lastSyncedAt);
    if (!Number.isFinite(localCollectedAt)
        || now - localCollectedAt > ATTENDANCE_FRESHNESS_MS) {
        return fetched;
    }
    if (fetched.state !== 'loaded' || fetched.attendance.status !== 'available') {
        return current;
    }

    const fetchedCollectedAt = Date.parse(fetched.attendance.lastSyncedAt);
    return Number.isFinite(fetchedCollectedAt) && fetchedCollectedAt >= localCollectedAt
        ? fetched
        : current;
}

export async function handleAttendanceSnapshotUpdated(
    client: QueryClient,
    payload: unknown,
): Promise<void> {
    const event = parseAttendanceSnapshotEvent(payload);
    if (!event) return;
    if (event.kind === 'observed') {
        client.setQueryData<AttendanceDashboard>(
            queryKeys.attendance('desktop'),
            (current) => dashboardWithLocalObservation(current, event.snapshot),
        );
        return;
    }
    await client.invalidateQueries({
        queryKey: queryKeys.attendance('desktop'),
        exact: true,
    });
}
