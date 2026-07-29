import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'vitest';

const uiStyles = readFileSync(new URL('./ui.css', import.meta.url), 'utf8');
const templates = ['index.html', 'onboarding.html', 'campus.html', 'image-viewer.html', 'tray-panel.html']
    .map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'));

test('공통 스크롤바 gutter는 양쪽 여백을 대칭으로 유지한다', () => {
    assert.match(uiStyles, /--scrollbar-size:\s*6px/);
    assert.match(uiStyles, /overflow-y:\s*scroll/);
    assert.match(uiStyles, /scrollbar-gutter:\s*stable both-edges/);
    assert.match(uiStyles, /\*::\-webkit-scrollbar-track\s*{\s*background:\s*var\(--color-bg\)/);
    assert.match(
        uiStyles,
        /\*::\-webkit-scrollbar\s*\{[^}]*width:\s*var\(--scrollbar-size\);[^}]*height:\s*var\(--scrollbar-size\);/s,
    );
    assert.match(
        uiStyles,
        /\.ui-scroll-region\s*\{[^}]*overflow-y:\s*scroll;[^}]*scrollbar-gutter:\s*stable both-edges;/s,
    );
    assert.match(
        uiStyles,
        /\.ui-scroll-region--inset\s*\{[^}]*padding-inline:\s*calc\(var\(--scroll-region-inset\) - var\(--scrollbar-size\)\);/s,
    );
    assert.match(
        uiStyles,
        /\.ui-scroll-region__content\s*\{[^}]*padding-inline:\s*calc\(var\(--scroll-region-inset\) - var\(--scrollbar-size\)\);/s,
    );
    assert.match(
        uiStyles,
        /\.ui-scroll-region--bleed\s*\{[^}]*overflow-y:\s*auto;[^}]*padding-inline:\s*0;[^}]*scrollbar-gutter:\s*auto;/s,
    );
});

test('모든 페이지는 재정의 가능한 전역 gutter를 사용한다', () => {
    assert.match(uiStyles, /--page-gutter:\s*var\(--space-3\)/);
    assert.match(
        uiStyles,
        /body\s*\{[^}]*padding-block:\s*var\(--page-gutter\);[^}]*padding-inline:\s*calc\(var\(--page-gutter\) - var\(--scrollbar-size\)\);/s,
    );
    assert.match(
        uiStyles,
        /html\[data-page-layout=["']bleed["']\]\s+body\s*\{[^}]*padding-inline:\s*var\(--page-gutter\);/s,
    );
    assert.match(uiStyles, /html\[data-page-layout=["']bleed["']\]\s*{\s*scrollbar-gutter:\s*auto/);

    for (const template of templates) {
        assert.doesNotMatch(template, /<body class="[^"]*\bp-4\b/);
    }

    const imageViewer = templates[3] ?? '';
    assert.match(imageViewer, /<html\b[^>]*\bdata-page-layout=["']bleed["']/);
    assert.match(imageViewer, /<main\b[^>]*\bfixed\b[^>]*\binset-0\b/);

    const settings = templates[0] ?? '';
    const campus = templates[2] ?? '';
    assert.doesNotMatch(settings, /<html\b[^>]*\bdata-page-layout=["']bleed["']/);
    assert.doesNotMatch(campus, /<html\b[^>]*\bdata-page-layout=["']bleed["']/);
});
