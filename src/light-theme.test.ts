import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'vitest';

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const localPages = [
    './index.html',
    './onboarding.html',
    './campus.html',
    './image-viewer.html',
];
const localStyles = [source('./styles.css'), source('./ui.css')].join('\n');
const windowSources = [
    source('../src-tauri/src/checker.rs'),
    source('../src-tauri/src/tray.rs'),
].join('\n');

test('로컬 UI는 라이트 color scheme만 선언한다', () => {
    assert.match(localStyles, /color-scheme:\s*only light/);
    assert.doesNotMatch(localStyles, /light-dark\(|prefers-color-scheme|color-scheme:\s*light dark/);

    for (const page of localPages) {
        assert.match(
            source(page),
            /<meta name="color-scheme" content="light"\/>/,
            `${page}가 초기 렌더링부터 라이트 모드를 선언해야 합니다.`,
        );
    }
});

test('모든 Tauri WebView 창은 라이트 테마로 고정한다', () => {
    const builderCount = windowSources.match(/WebviewWindowBuilder::new\(/g)?.length ?? 0;
    const lightThemeCount =
        windowSources.match(/\.theme\(Some\(tauri::Theme::Light\)\)/g)?.length ?? 0;

    assert.ok(builderCount > 0);
    assert.equal(lightThemeCount, builderCount);
});
