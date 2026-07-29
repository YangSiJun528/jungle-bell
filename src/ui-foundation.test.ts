import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'vitest';

const uiStyles = readFileSync(new URL('./ui.css', import.meta.url), 'utf8');
const templates = ['index.html', 'onboarding.html', 'campus.html', 'image-viewer.html', 'tray-panel.html']
    .map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'));

test('공통 스크롤바 gutter는 양쪽 여백을 대칭으로 유지한다', () => {
    assert.match(uiStyles, /overflow-y:\s*scroll/);
    assert.match(uiStyles, /scrollbar-gutter:\s*stable both-edges/);
    assert.match(uiStyles, /\*::\-webkit-scrollbar-track\s*{\s*background:\s*var\(--color-bg\)/);
});

test('모든 페이지는 재정의 가능한 전역 gutter를 사용한다', () => {
    assert.match(uiStyles, /--page-gutter:\s*var\(--space-4\)/);
    assert.match(uiStyles, /body\s*{\s*padding:\s*var\(--page-gutter\)/);
    assert.match(uiStyles, /html\[data-page-layout=["']bleed["']\]\s*{\s*scrollbar-gutter:\s*auto/);

    for (const template of templates) {
        assert.doesNotMatch(template, /<body class="[^"]*\bp-4\b/);
    }

    const imageViewer = templates[3] ?? '';
    assert.match(imageViewer, /<html\b[^>]*\bdata-page-layout=["']bleed["']/);
    assert.match(imageViewer, /<main\b[^>]*\bfixed\b[^>]*\binset-0\b/);
});
