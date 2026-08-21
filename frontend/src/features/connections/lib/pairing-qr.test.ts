import assert from 'node:assert/strict';

import {test} from 'vitest';

import {pairingQrDataUrl} from './pairing-qr';

test('서버 QR payload는 DOM HTML 삽입 없이 SVG data URI로 변환한다', () => {
    const payload =
        'https://example.com/#pairing=jbc_0123456789abcdef0123456789abcdef&challenge=jbp_test';
    const url = pairingQrDataUrl(payload);

    assert.match(url, /^data:image\/svg\+xml;charset=utf-8,/);
    assert.match(decodeURIComponent(url.slice(url.indexOf(',') + 1)), /^<svg/);
    assert.doesNotMatch(url, /<script|onerror=/i);
});

test('빈 값이나 과도한 payload는 QR로 만들지 않는다', () => {
    assert.throws(() => pairingQrDataUrl(''));
    assert.throws(() => pairingQrDataUrl('x'.repeat(4_097)));
});
