import {describe, expect, test} from 'vitest';

import {dateTimeLabel, relativeTimeLabel} from './format';

const now = Date.parse('2026-09-17T12:00:00.000Z');

describe('relativeTimeLabel', () => {
    test.each([
        [0, '방금 전'],
        [29_999, '방금 전'],
        [30_000, '방금 전'],
        [59_999, '방금 전'],
        [60_000, '1분 전'],
        [90_000, '1분 전'],
        [119_999, '1분 전'],
        [120_000, '2분 전'],
        [3_599_999, '59분 전'],
        [3_600_000, '1시간 전'],
        [5_400_000, '1시간 전'],
        [7_199_999, '1시간 전'],
        [7_200_000, '2시간 전'],
        [84_600_000, '23시간 전'],
        [86_399_999, '23시간 전'],
    ])('%i밀리초 경과 시 "%s" 표시', (elapsed, expected) => {
        expect(relativeTimeLabel(now - elapsed, now)).toBe(expected);
    });

    test('문자열 시각도 실제로 지난 분까지만 표시한다', () => {
        expect(relativeTimeLabel('2026-09-17T11:58:00.001Z', now)).toBe('1분 전');
    });

    test.each([86_400_000, 172_800_000])(
        '하루 이상 지나면 날짜와 시각으로 표시한다: %i',
        (elapsed) => {
            const timestamp = now - elapsed;
            expect(relativeTimeLabel(timestamp, now)).toBe(dateTimeLabel(timestamp));
        },
    );

    test.each([null, undefined, '', 'not-a-date', NaN, Infinity])(
        '시각이 없거나 잘못되면 확인 기록 없음으로 표시한다: %s',
        (value) => {
            expect(relativeTimeLabel(value, now)).toBe('확인 기록 없음');
        },
    );

    test.each([1, 60_000, 86_400_000])('미래 시각은 방금 전으로 표시한다: %i밀리초 후', (ahead) => {
        expect(relativeTimeLabel(now + ahead, now)).toBe('방금 전');
    });
});
