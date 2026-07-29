import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'vitest';
import {
    clampSteppedZoomPercent,
    nextSteppedZoomPercent,
    resizeObservationSize,
} from './image-viewer.ts';

test('ResizeObserver 크기는 배열, 단일 객체, contentRect fallback을 모두 지원한다', () => {
    assert.deepEqual(
        resizeObservationSize({
            contentBoxSize: [{inlineSize: 640, blockSize: 480}],
            contentRect: {width: 1, height: 1},
        }),
        {width: 640, height: 480},
    );
    assert.deepEqual(
        resizeObservationSize({
            contentBoxSize: {inlineSize: 520, blockSize: 360},
            contentRect: {width: 1, height: 1},
        }),
        {width: 520, height: 360},
    );
    assert.deepEqual(
        resizeObservationSize({contentRect: {width: 420, height: 320}}),
        {width: 420, height: 320},
    );
    assert.deepEqual(
        resizeObservationSize({contentBoxSize: [], contentRect: {width: 390, height: 280}}),
        {width: 390, height: 280},
    );
});

test('수동 배율은 25% 단위로 25%와 400% 사이에서 이동한다', () => {
    assert.equal(clampSteppedZoomPercent(-100), 25);
    assert.equal(clampSteppedZoomPercent(100), 100);
    assert.equal(clampSteppedZoomPercent(412), 400);
    assert.equal(nextSteppedZoomPercent(62.5, 1), 75);
    assert.equal(nextSteppedZoomPercent(62.5, -1), 50);
    assert.equal(nextSteppedZoomPercent(12, 1), 25);
    assert.equal(nextSteppedZoomPercent(25, -1), 25);
    assert.equal(nextSteppedZoomPercent(400, 1), 400);
});

test('이미지 뷰어는 이미지를 화면에 맞추고 확대 시 스크롤할 수 있다', () => {
    const html = readFileSync(new URL('./image-viewer.html', import.meta.url), 'utf8');
    const script = readFileSync(new URL('./image-viewer.ts', import.meta.url), 'utf8');
    assert.doesNotMatch(html, /식단/);
    assert.doesNotMatch(script, /\bcaption\b/);
    assert.doesNotMatch(html, /\bobject-contain\b/);
    assert.match(html, /\bid="image-viewer-viewport"[^>]*\boverflow-auto\b/);
    assert.match(
        html,
        /\bid="image-viewer-viewport"[^>]*\bui-scroll-region\b[^>]*\bui-scroll-region--bleed\b/,
    );
    assert.match(html, /\bid="image-viewer-canvas"/);
    assert.match(html, /\bid="image-fit-layer"/);
    assert.match(html, /<main\b[^>]*\bfixed\b[^>]*\binset-0\b/);
    assert.match(script, /addEventListener\(['"]resize['"],\s*updateImageFitFromViewport\)/);
    assert.match(script, /new ResizeObserver\(/);
    assert.match(script, /\bnaturalWidth\b/);
    assert.match(script, /calculateImageFitScale\(/);
    assert.match(script, /\bfitImage\b/);
    assert.doesNotMatch(script, /requestAnimationFrame|setTimeout/);
    assert.match(html, /<html\b[^>]*\boverflow-hidden\b[^>]*\bbg-app-bg\b/);
    assert.match(html, /<body\b[^>]*\bbg-app-bg\b/);
});

test('이미지 뷰어는 25%부터 400%까지 확대·축소, 100%, 화면 맞춤 제어를 제공한다', () => {
    const html = readFileSync(new URL('./image-viewer.html', import.meta.url), 'utf8');
    const script = readFileSync(new URL('./image-viewer.ts', import.meta.url), 'utf8');

    assert.match(html, /\bid="image-viewer-zoom-out"/);
    assert.match(html, /\bid="image-viewer-zoom-in"/);
    assert.match(html, /\bid="image-viewer-actual-size"/);
    assert.match(html, /\bid="image-viewer-fit"/);
    assert.match(html, /<output\b[^>]*\bid="image-viewer-zoom"[^>]*\baria-live="polite"/);
    assert.match(html, /\bid="image-viewer-zoom-out"[^>]*\bui-button\b/);
    assert.match(html, /\bid="image-viewer-zoom-in"[^>]*\bui-button\b/);
    assert.match(html, /\bid="image-viewer-actual-size"[^>]*\bui-button\b/);
    assert.match(html, /\bid="image-viewer-fit"[^>]*\bui-button\b/);
    assert.match(html, /\bmotion-reduce:animate-none\b/);

    assert.match(script, /const MIN_ZOOM_PERCENT = 25/);
    assert.match(script, /const MAX_ZOOM_PERCENT = 400/);
    assert.match(script, /const ZOOM_STEP_PERCENT = 25/);
    assert.match(script, /zoomOutButton\.addEventListener\(['"]click['"]/);
    assert.match(script, /zoomInButton\.addEventListener\(['"]click['"]/);
    assert.match(script, /actualSizeButton\.addEventListener\(['"]click['"]/);
    assert.match(script, /fitButton\.addEventListener\(['"]click['"]/);
    assert.match(script, /window\.addEventListener\(['"]keydown['"],\s*handleKeyboardShortcut\)/);
    assert.match(script, /event\.key === ['"]\+['"]/);
    assert.match(script, /event\.key === ['"]-['"]/);
    assert.match(script, /event\.key === ['"]0['"]/);
    assert.match(script, /event\.key\.toLowerCase\(\) === ['"]f['"]/);
    assert.doesNotMatch(script, /Panzoom|panzoom|zoomWithWheel/);
    assert.doesNotMatch(script, /addEventListener\(['"]wheel['"]/);
});

test('이미지 뷰어는 로딩 상태와 오류 후 재시도를 제공한다', () => {
    const html = readFileSync(new URL('./image-viewer.html', import.meta.url), 'utf8');
    const script = readFileSync(new URL('./image-viewer.ts', import.meta.url), 'utf8');
    const viewport = html.match(/<div\b[^>]*\bid="image-viewer-viewport"[^>]*>/)?.[0] ?? '';
    const loading = html.match(/<section\b[^>]*\bid="image-viewer-loading"[^>]*>/)?.[0] ?? '';
    assert.match(html, /\bid="image-viewer-loading"/);
    assert.match(html, /\bid="image-viewer-error"/);
    assert.match(html, /\bid="image-viewer-retry"/);
    assert.match(viewport, /\btabindex="0"/);
    assert.match(viewport, /\brole="region"/);
    assert.match(viewport, /\baria-label="[^"]*방향키[^"]*"/);
    assert.match(loading, /\btabindex="-1"/);
    assert.doesNotMatch(html, /\bp-6\b/);
    assert.match(html, /이미지를 불러오지 못했습니다/);
    assert.match(script, /IMAGE_LOAD_TIMEOUT_MS/);
    assert.match(script, /retryButton\.addEventListener\(['"]click['"]/);
    assert.match(script, /loadingElement\.focus\(\)/);
    assert.match(script, /retryButton\.focus\(\)/);
    assert.match(script, /viewportElement\.focus\(\)/);
});
