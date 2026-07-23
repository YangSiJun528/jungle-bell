import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'vitest';

test('이미지 뷰어는 고정 크기 이미지를 합성 transform으로 화면에 맞춘다', () => {
    const html = readFileSync(new URL('./image-viewer.html', import.meta.url), 'utf8');
    const script = readFileSync(new URL('./image-viewer.ts', import.meta.url), 'utf8');
    assert.doesNotMatch(html, /<(?:header|nav|output)\b/);
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

test('이미지 뷰어는 로딩 상태와 오류 후 재시도를 제공한다', () => {
    const html = readFileSync(new URL('./image-viewer.html', import.meta.url), 'utf8');
    const script = readFileSync(new URL('./image-viewer.ts', import.meta.url), 'utf8');
    assert.match(html, /\bid="image-viewer-loading"/);
    assert.match(html, /\bid="image-viewer-error"/);
    assert.match(html, /\bid="image-viewer-retry"/);
    assert.doesNotMatch(html, /\bp-6\b/);
    assert.match(html, /이미지를 불러오지 못했습니다/);
    assert.match(script, /IMAGE_LOAD_TIMEOUT_MS/);
    assert.match(script, /retryButton\.addEventListener\(['"]click['"]/);
});
