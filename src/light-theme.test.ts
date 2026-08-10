import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'vitest';

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const localPages = [
    './dashboard.html',
    './image-viewer.html',
];
const localStyles = [source('./styles.css'), source('./ui.css')].join('\n');
const checkerSource = source('../src-tauri/src/checker.rs');
const traySource = source('../src-tauri/src/tray.rs');

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

test('사용자 UI 창은 라이트로 고정하고 숨겨진 checker만 시스템 테마를 감지한다', () => {
    const userWindowBuilderCount = traySource.match(/WebviewWindowBuilder::new\(/g)?.length ?? 0;
    const lightThemeCount = traySource.match(/\.theme\(Some\(tauri::Theme::Light\)\)/g)?.length ?? 0;

    assert.ok(userWindowBuilderCount > 0);
    assert.equal(lightThemeCount, userWindowBuilderCount);
    assert.match(checkerSource, /WebviewWindowBuilder::new\(/);
    assert.doesNotMatch(checkerSource, /\.theme\(Some\(tauri::Theme::Light\)\)/);
    assert.match(checkerSource, /WindowEvent::ThemeChanged\(theme\)/);
    assert.match(checkerSource, /tray::sync_icon_theme\(&app_handle, \*theme\)/);
});
