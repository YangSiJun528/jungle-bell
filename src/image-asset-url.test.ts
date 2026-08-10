import assert from 'node:assert/strict';
import {test} from 'vitest';
import {isSafeImageAssetUrl} from './image-asset-url.ts';

test('이미지 자산 URL은 HTTPS 또는 로컬 HTTP의 assets 경로만 허용한다', () => {
    assert.equal(isSafeImageAssetUrl('https://api.example.com/api/public/assets/menu.png'), true);
    assert.equal(isSafeImageAssetUrl('http://127.0.0.1:43120/api/public/assets/menu.png'), true);
    assert.equal(isSafeImageAssetUrl('http://example.com/api/public/assets/menu.png'), false);
    assert.equal(isSafeImageAssetUrl('https://api.example.com/other/menu.png'), false);
    assert.equal(isSafeImageAssetUrl('javascript:alert(1)'), false);
});
