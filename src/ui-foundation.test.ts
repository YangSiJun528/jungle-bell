import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'vitest';

const uiStyles = readFileSync(new URL('./ui.css', import.meta.url), 'utf8');

test('공통 스크롤바 gutter는 양쪽 여백을 대칭으로 유지한다', () => {
    assert.match(uiStyles, /scrollbar-gutter:\s*stable both-edges/);
    assert.match(uiStyles, /\*::\-webkit-scrollbar-track\s*{\s*background:\s*var\(--color-bg\)/);
});
