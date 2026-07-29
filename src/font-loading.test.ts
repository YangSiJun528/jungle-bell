import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'vitest';

const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
const uiStyles = readFileSync(new URL('./ui.css', import.meta.url), 'utf8');
const templates = ['index.html', 'onboarding.html', 'campus.html', 'image-viewer.html']
    .map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'));

test('Pretendard Variable 폰트는 크로스 플랫폼 선언과 fallback을 사용한다', () => {
    assert.match(styles, /font-family:\s*["']Pretendard Variable["']/);
    assert.match(styles, /format\(["']woff2-variations["']\)/);
    assert.match(styles, /--font-family:\s*["']Pretendard Variable["'],\s*Pretendard,/);
});

test('font-sans와 font-mono는 모두 번들된 전역 폰트를 사용한다', () => {
    const sources = [styles, uiStyles, ...templates].join('\n');
    assert.match(uiStyles, /--font-sans:\s*var\(--font-family\)/);
    assert.match(uiStyles, /--font-mono:\s*var\(--font-family\)/);
    assert.doesNotMatch(sources, /--font-data|\bfont-data\b|SFMono|Cascadia Code|Roboto Mono/);
    assert.match(styles, /button,\s*input,\s*select,\s*textarea,\s*code,\s*kbd,\s*samp,\s*pre\s*{\s*font:\s*inherit/);

    for (const template of templates) {
        assert.match(template, /<body\b[^>]*class="[^"]*\bfont-sans\b/);
        for (const match of template.matchAll(/class="([^"]*\btabular-nums\b[^"]*)"/g)) {
            const className = match[1];
            assert.ok(className);
            assert.match(className, /\bfont-mono\b/);
        }
    }
});
