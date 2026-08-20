import {describe, expect, test} from 'vitest';
import {pairingRemainingLabel} from './pairing-expiry';

describe('pairing expiry label', () => {
    test('남은 시간을 분과 초로 표시한다', () => {
        expect(pairingRemainingLabel('2026-08-20T12:02:00.000Z', Date.parse('2026-08-20T12:00:18.000Z')))
            .toBe('남은 시간 01:42');
    });

    test('만료되었거나 잘못된 시각은 만료로 표시한다', () => {
        expect(pairingRemainingLabel('2026-08-20T12:00:00.000Z', Date.parse('2026-08-20T12:00:01.000Z')))
            .toBe('만료됨');
        expect(pairingRemainingLabel('not-a-date', 0)).toBe('만료됨');
    });
});
