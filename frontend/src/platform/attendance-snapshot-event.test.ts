import {describe, expect, test} from 'vitest';
import {attendanceSnapshotRevision} from './attendance-snapshot-event';

describe('attendanceSnapshotRevision', () => {
    test('양의 안전 정수 revision만 허용한다', () => {
        expect(attendanceSnapshotRevision({revision: 1})).toBe(1);
        expect(attendanceSnapshotRevision({revision: Number.MAX_SAFE_INTEGER})).toBe(Number.MAX_SAFE_INTEGER);
    });

    test.each([
        null,
        [],
        {},
        {revision: 0},
        {revision: -1},
        {revision: 1.5},
        {revision: Number.MAX_SAFE_INTEGER + 1},
        {revision: '1'},
        {revision: 1, snapshot: {morningChecked: true}},
    ])('잘못되거나 필드가 추가된 이벤트를 거부한다: %j', (payload) => {
        expect(attendanceSnapshotRevision(payload)).toBeNull();
    });
});
