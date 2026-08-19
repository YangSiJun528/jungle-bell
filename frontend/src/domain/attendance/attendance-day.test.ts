import {describe, expect, it} from 'vitest';
import {effectiveAttendanceDate} from './attendance-day';

describe('effectiveAttendanceDate', () => {
    it.each([
        ['2026-08-19T14:59:59.000Z', '2026-08-19'], // KST 23:59:59
        ['2026-08-19T15:00:00.000Z', '2026-08-19'], // KST 00:00:00
        ['2026-08-19T18:59:59.000Z', '2026-08-19'], // KST 03:59:59
        ['2026-08-19T19:00:00.000Z', '2026-08-20'], // KST 04:00:00
    ])('04:00 KST를 출석일 경계로 사용한다: %s', (timestamp, expected) => {
        expect(effectiveAttendanceDate(Date.parse(timestamp))).toBe(expected);
    });
});
