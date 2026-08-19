import type {QueryClient} from '@tanstack/react-query';
import {attendanceSnapshotRevision} from '@/platform/attendance-snapshot-event';
import {queryKeys} from './dashboard-context';

export async function handleAttendanceSnapshotUpdated(
    client: QueryClient,
    payload: unknown,
): Promise<void> {
    if (attendanceSnapshotRevision(payload) === null) return;
    await client.invalidateQueries({
        queryKey: queryKeys.attendance('desktop'),
        exact: true,
    });
}
