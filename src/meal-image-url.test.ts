import assert from 'node:assert/strict';
import {test} from 'vitest';
import {isSafeMealImageUrl} from './meal-image-url.ts';

test('식단 이미지 URL은 HTTPS 또는 로컬 HTTP의 assets 경로만 허용한다', () => {
    assert.equal(isSafeMealImageUrl('https://api.example.com/v1/assets/menu.png'), true);
    assert.equal(isSafeMealImageUrl('http://127.0.0.1:43120/v1/assets/menu.png'), true);
    assert.equal(isSafeMealImageUrl('http://example.com/v1/assets/menu.png'), false);
    assert.equal(isSafeMealImageUrl('https://api.example.com/other/menu.png'), false);
    assert.equal(isSafeMealImageUrl('javascript:alert(1)'), false);
});
