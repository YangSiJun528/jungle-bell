import {describe, expect, test} from 'vitest';

import {releaseExclusiveAction, tryReserveExclusiveAction} from './exclusive-action';

describe('exclusive destructive action gate', () => {
    test('동기적인 연속 실행을 하나만 허용하고 완료 뒤 다시 열어 준다', () => {
        const gate = {inFlight: false};

        expect(tryReserveExclusiveAction(gate)).toBe(true);
        expect(tryReserveExclusiveAction(gate)).toBe(false);
        releaseExclusiveAction(gate);
        expect(tryReserveExclusiveAction(gate)).toBe(true);
    });
});
