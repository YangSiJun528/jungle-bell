import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'vitest';

const srcRoot = new URL('../../', import.meta.url);
const source = (path: string) => readFileSync(new URL(path, srcRoot), 'utf8');
const dashboard = source('./index.html');
const globals = source('./app/styles/globals.css');
const main = source('./app/main.tsx');
const checker = source('../src-tauri/src/checker.rs');
const tray = source('../src-tauri/src/tray.rs');

test('대시보드는 첫 페인트부터 라이트·다크 color scheme과 테마 색상을 모두 선언한다', () => {
    assert.match(dashboard, /<meta name="color-scheme" content="light dark"\/>/);
    assert.match(dashboard, /<meta name="theme-color" media="\(prefers-color-scheme: light\)" content="#[0-9a-f]{6}"\/>/i);
    assert.match(dashboard, /<meta name="theme-color" media="\(prefers-color-scheme: dark\)" content="#[0-9a-f]{6}"\/>/i);
    assert.match(globals, /:root\s*\{[\s\S]*color-scheme:\s*light/);
    assert.match(globals, /\.dark\s*\{[\s\S]*color-scheme:\s*dark/);
});

test('React 진입점은 시스템 테마를 즉시 적용하고 변경도 추적한다', () => {
    assert.match(main, /window\.matchMedia\('\(prefers-color-scheme: dark\)'\)/);
    assert.match(main, /document\.documentElement\.classList\.toggle\('dark', theme\.matches\)/);
    assert.match(main, /syncTheme\(\)/);
    assert.match(main, /theme\.addEventListener\('change', syncTheme\)/);
    assert.match(globals, /@custom-variant dark/);
});

test('핵심 화면의 상태 색상은 다크 테마 대응 유틸리티를 함께 제공한다', () => {
    const sources = [
        source('./features/home/home-page.tsx'),
        source('./features/attendance/attendance-page.tsx'),
    ].join('\n');

    assert.match(sources, /dark:text-emerald-/);
    assert.match(sources, /dark:text-amber-/);
    assert.doesNotMatch(sources, /color-scheme:\s*only light/);
});

test('트레이 아이콘도 시스템 테마 변경에 맞춰 라이트·다크 자산을 교체한다', () => {
    assert.match(tray, /enum TrayIconTheme\s*\{[\s\S]*Light,[\s\S]*Dark/);
    assert.match(tray, /impl From<tauri::Theme> for TrayIconTheme/);
    for (const status of ['OFFLINE', 'NORMAL', 'WARNING', 'ALERT', 'COMPLETE']) {
        assert.match(tray, new RegExp(`ICON_${status}_LIGHT`));
        assert.match(tray, new RegExp(`ICON_${status}_DARK`));
    }
    assert.match(tray, /pub fn sync_icon_theme/);
    assert.match(checker, /WindowEvent::ThemeChanged\(theme\)/);
    assert.match(checker, /tray::sync_icon_theme\(&app_handle, \*theme\)/);
});
