import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'vitest';
import {PANZOOM_OPTIONS} from './image-viewer-options.ts';

test('Panzoom은 화면 맞춤 배율 아래로 축소되지 않고 확대할 때만 이동한다', () => {
    assert.equal(PANZOOM_OPTIONS.minScale, 1);
    assert.equal(PANZOOM_OPTIONS.maxScale, 4);
    assert.equal(PANZOOM_OPTIONS.panOnlyWhenZoomed, true);
    assert.equal(PANZOOM_OPTIONS.contain, 'outside');
    assert.equal(PANZOOM_OPTIONS.canvas, true);
    assert.equal(PANZOOM_OPTIONS.touchAction, 'none');
});

test('이미지 뷰어는 별도 UI와 수동 창 크기 보정 없이 이미지를 화면에 맞춘다', () => {
    const html = readFileSync(new URL('./image-viewer.html', import.meta.url), 'utf8');
    const script = readFileSync(new URL('./image-viewer.ts', import.meta.url), 'utf8');
    assert.doesNotMatch(html, /<(?:button|header|nav|output)\b/);
    assert.doesNotMatch(script, /\bcaption\b/);
    assert.doesNotMatch(script, /addEventListener\(['"]resize['"]/);
    assert.match(html, /<img\b[^>]*\bobject-contain\b/);
    assert.match(html, /<html\b[^>]*\boverflow-hidden\b[^>]*\bbg-app-bg\b/);
    assert.match(html, /<body\b[^>]*\bbg-app-bg\b/);
    assert.match(script, /from ['"]@panzoom\/panzoom\//);
});
