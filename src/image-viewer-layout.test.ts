import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'vitest';

test('이미지 뷰어는 고정 크기 이미지를 합성 transform으로 화면에 맞춘다', () => {
    const html = readFileSync(new URL('./image-viewer.html', import.meta.url), 'utf8');
    const script = readFileSync(new URL('./image-viewer.ts', import.meta.url), 'utf8');
    assert.doesNotMatch(html, /<(?:button|header|nav|output)\b/);
    assert.doesNotMatch(html, /식단/);
    assert.doesNotMatch(script, /\bcaption\b/);
    assert.doesNotMatch(html, /\bobject-contain\b/);
    assert.match(html, /\bid="image-fit-layer"/);
    assert.match(html, /<main\b[^>]*\bfixed\b[^>]*\binset-0\b/);
    assert.match(script, /addEventListener\(['"]resize['"],\s*updateImageFitFromViewport\)/);
    assert.match(script, /new ResizeObserver\(/);
    assert.match(script, /\bnaturalWidth\b/);
    assert.doesNotMatch(script, /requestAnimationFrame|setTimeout/);
    assert.match(html, /<html\b[^>]*\boverflow-hidden\b[^>]*\bbg-app-bg\b/);
    assert.match(html, /<body\b[^>]*\bbg-app-bg\b/);
});

test('이미지 뷰어는 확대 또는 이동 기능을 포함하지 않는다', () => {
    const html = readFileSync(new URL('./image-viewer.html', import.meta.url), 'utf8');
    const script = readFileSync(new URL('./image-viewer.ts', import.meta.url), 'utf8');
    assert.doesNotMatch(html, /image-panzoom-layer/);
    assert.doesNotMatch(script, /Panzoom|panzoom|zoomWithWheel/);
    assert.doesNotMatch(script, /addEventListener\(['"]wheel['"]/);
});
