import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'vitest';

const srcRoot = new URL('../../', import.meta.url);
const tray = readFileSync(new URL('../src-tauri/src/tray.rs', srcRoot), 'utf8');

function sourceBetween(source: string, start: string, end: string): string {
    const startIndex = source.indexOf(start);
    const endIndex = source.indexOf(end, startIndex + start.length);
    assert.ok(startIndex >= 0, `${start} 시작점을 찾을 수 없습니다.`);
    assert.ok(endIndex > startIndex, `${end} 종료점을 찾을 수 없습니다.`);
    return source.slice(startIndex, endIndex);
}

test('구형 설정·온보딩·캠퍼스·출석 전용 창은 만들지 않는다', () => {
    assert.doesNotMatch(tray, /WebviewUrl::App\("(?:index|onboarding|campus)\.html"/);
    assert.doesNotMatch(
        tray,
        /WebviewWindowBuilder::new\([^\n]+,\s*"(?:onboarding|campus|attendance)"/,
    );
});

test('대시보드 창은 사이드바와 내용을 표시할 크기에서 시작하고 최대화할 수 있다', () => {
    const dashboard = sourceBetween(tray, 'fn build_dashboard_window', 'pub fn open_dashboard_window');

    assert.match(tray, /const DASHBOARD_WINDOW_WIDTH: f64 = 1180\.0;/);
    assert.match(tray, /const DASHBOARD_WINDOW_HEIGHT: f64 = 780\.0;/);
    assert.match(tray, /const DASHBOARD_WINDOW_MIN_WIDTH: f64 = 760\.0;/);
    assert.match(tray, /const DASHBOARD_WINDOW_MIN_HEIGHT: f64 = 560\.0;/);
    assert.match(dashboard, /\.inner_size\(DASHBOARD_WINDOW_WIDTH, DASHBOARD_WINDOW_HEIGHT\)/);
    assert.match(
        dashboard,
        /\.min_inner_size\(DASHBOARD_WINDOW_MIN_WIDTH, DASHBOARD_WINDOW_MIN_HEIGHT\)/,
    );
    assert.match(dashboard, /\.resizable\(true\)/);
    assert.match(dashboard, /\.minimizable\(true\)/);
    assert.match(dashboard, /\.maximizable\(true\)/);
});

test('트레이 클릭은 별도 목록 창 없이 대시보드 홈을 연다', () => {
    const setup = sourceBetween(tray, 'pub fn setup_tray', 'pub fn sync_icon_theme');

    assert.match(setup, /on_tray_icon_event[\s\S]*open_dashboard_window\(tray\.app_handle\(\)\)/);
    assert.match(tray, /pub fn open_dashboard_window[\s\S]*DashboardRoute::Home/);
    assert.doesNotMatch(tray, /TRAY_PANEL_(?:WIDTH|HEIGHT)|build_tray_panel_window|toggle_tray_panel/);
});
