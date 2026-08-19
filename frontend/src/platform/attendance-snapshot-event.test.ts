import {describe, expect, test} from 'vitest';
import {parseAttendanceSnapshotEvent} from './attendance-snapshot-event';

const snapshot = {
    attendanceDate: '2026-08-19',
    cohortId: 'cohort-1',
    cohortStatus: 'active',
    cohortStartDate: '2026-08-01',
    cohortEndDate: '2026-08-31',
    morningChecked: true,
    eveningChecked: false,
    collectedAt: '2026-08-19T16:13:00.000Z',
};

describe('parseAttendanceSnapshotEvent', () => {
    test('검증된 로컬 관측과 서버 동기화 완료 이벤트를 구분한다', () => {
        expect(parseAttendanceSnapshotEvent({kind: 'observed', snapshot})).toEqual({kind: 'observed', snapshot});
        expect(parseAttendanceSnapshotEvent({kind: 'synced', revision: 1})).toEqual({kind: 'synced', revision: 1});
        expect(parseAttendanceSnapshotEvent({kind: 'synced', revision: Number.MAX_SAFE_INTEGER}))
            .toEqual({kind: 'synced', revision: Number.MAX_SAFE_INTEGER});
    });

    test.each([
        null,
        [],
        {},
        {kind: 'synced', revision: 0},
        {kind: 'synced', revision: -1},
        {kind: 'synced', revision: 1.5},
        {kind: 'synced', revision: Number.MAX_SAFE_INTEGER + 1},
        {kind: 'synced', revision: '1'},
        {kind: 'synced', revision: 1, snapshot},
        {kind: 'observed', snapshot: {...snapshot, attendanceDate: 'not-a-date'}},
        {kind: 'observed', snapshot, revision: 1},
    ])('잘못되거나 필드가 추가된 이벤트를 거부한다: %j', (payload) => {
        expect(parseAttendanceSnapshotEvent(payload)).toBeNull();
    });
});
