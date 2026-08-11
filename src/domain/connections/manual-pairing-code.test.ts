import assert from 'node:assert/strict';
import {test} from 'vitest';
import {
    formatManualPairingCode,
    normalizeManualPairingCode,
    validManualPairingCode,
} from './manual-pairing-code';

test('Crockford Base32 연결 코드는 구분자를 제거하고 혼동 문자를 정규화한다', () => {
    assert.equal(normalizeManualPairingCode('abCde-23oIl'), 'ABCDE23011');
    assert.equal(normalizeManualPairingCode(' ab cde 2345 '), 'ABCDE2345');
    assert.equal(normalizeManualPairingCode('abcdu-2345'), 'ABCDU2345');
    assert.equal(validManualPairingCode('ABCDE-23011'), true);
    assert.equal(validManualPairingCode('ABCDU-2345'), false);
    assert.equal(validManualPairingCode('ABCD-2345'), false);
    assert.equal(formatManualPairingCode('abcde23011'), 'ABCDE-23011');
});
