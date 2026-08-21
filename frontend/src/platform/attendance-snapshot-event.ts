import {z} from 'zod';

import {attendanceSnapshotSchema, type AttendanceSnapshot} from '@/api/dashboard-account-contract';

const attendanceSnapshotEventSchema = z.discriminatedUnion('kind', [
    z.strictObject({
        kind: z.literal('observed'),
        snapshot: attendanceSnapshotSchema,
    }),
    z.strictObject({
        kind: z.literal('synced'),
        revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    }),
]);

export type AttendanceSnapshotEvent =
    | {kind: 'observed'; snapshot: AttendanceSnapshot}
    | {kind: 'synced'; revision: number};

export function parseAttendanceSnapshotEvent(value: unknown): AttendanceSnapshotEvent | null {
    const parsed = attendanceSnapshotEventSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
}
