import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'vitest';

const tray = readFileSync(new URL('../src-tauri/src/tray.rs', import.meta.url), 'utf8');

function sourceBetween(source: string, start: string, end: string): string {
    const startIndex = source.indexOf(start);
    const endIndex = source.indexOf(end, startIndex + start.length);
    assert.ok(startIndex >= 0, `${start} 시작점을 찾을 수 없습니다.`);
    assert.ok(endIndex > startIndex, `${end} 종료점을 찾을 수 없습니다.`);
    return source.slice(startIndex, endIndex);
}

test('설정과 온보딩 창은 초기 크기를 유지하며 작은 화면에서도 리사이즈할 수 있다', () => {
    const settings = sourceBetween(tray, 'fn build_settings_window', 'fn build_onboarding_window');
    const onboarding = sourceBetween(tray, 'fn build_onboarding_window', 'pub fn open_onboarding_window');

    assert.match(tray, /const UTILITY_WINDOW_WIDTH: f64 = 560\.0;/);
    assert.match(tray, /const STANDARD_WINDOW_HEIGHT: f64 = 720\.0;/);
    assert.match(tray, /const UTILITY_WINDOW_MIN_WIDTH: f64 = 520\.0;/);
    assert.match(tray, /const UTILITY_WINDOW_MIN_HEIGHT: f64 = 600\.0;/);

    for (const windowBuilder of [settings, onboarding]) {
        assert.match(windowBuilder, /\.inner_size\(UTILITY_WINDOW_WIDTH, STANDARD_WINDOW_HEIGHT\)/);
        assert.match(
            windowBuilder,
            /\.min_inner_size\(UTILITY_WINDOW_MIN_WIDTH, UTILITY_WINDOW_MIN_HEIGHT\)/,
        );
        assert.match(windowBuilder, /\.resizable\(true\)/);
        assert.match(windowBuilder, /\.minimizable\(true\)/);
        assert.match(windowBuilder, /\.maximizable\(false\)/);
    }
});

test('생활 정보 창은 기존 720 정사각형에서 시작하고 더 넓게 조절하거나 최대화할 수 있다', () => {
    const campus = sourceBetween(tray, 'fn build_campus_window', 'fn open_campus_window');

    assert.match(tray, /const CONTENT_WINDOW_WIDTH: f64 = 720\.0;/);
    assert.match(tray, /const STANDARD_WINDOW_HEIGHT: f64 = 720\.0;/);
    assert.match(tray, /const CAMPUS_WINDOW_MIN_WIDTH: f64 = 640\.0;/);
    assert.match(tray, /const CAMPUS_WINDOW_MIN_HEIGHT: f64 = 600\.0;/);
    assert.match(campus, /\.inner_size\(CONTENT_WINDOW_WIDTH, STANDARD_WINDOW_HEIGHT\)/);
    assert.match(
        campus,
        /\.min_inner_size\(CAMPUS_WINDOW_MIN_WIDTH, CAMPUS_WINDOW_MIN_HEIGHT\)/,
    );
    assert.match(campus, /\.resizable\(true\)/);
    assert.match(campus, /\.minimizable\(true\)/);
    assert.match(campus, /\.maximizable\(true\)/);
});

test('트레이 패널은 시스템 보조 창으로 고정 크기를 유지한다', () => {
    const trayPanel = sourceBetween(tray, 'fn build_tray_panel_window', 'fn toggle_tray_panel');

    assert.match(trayPanel, /\.inner_size\(TRAY_PANEL_WIDTH, TRAY_PANEL_HEIGHT\)/);
    assert.match(trayPanel, /\.resizable\(false\)/);
    assert.match(trayPanel, /\.minimizable\(false\)/);
    assert.match(trayPanel, /\.maximizable\(false\)/);
    assert.doesNotMatch(trayPanel, /\.min_inner_size\(/);
});
