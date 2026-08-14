import {describe, expect, test} from 'vitest';
import {mobilePairingLinkFromHash} from './pairing-link';

describe('mobile pairing link', () => {
    test('QR fragment를 연결 입력으로 복원한다', () => {
        expect(mobilePairingLinkFromHash('#pairing=jbp_123&challenge=jbpc_456')).toEqual({
            pairingId: 'jbp_123',
            challenge: 'jbpc_456',
        });
        expect(mobilePairingLinkFromHash('#home')).toBeNull();
    });
});
