import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'vitest';

const onboarding = readFileSync(new URL('./onboarding.html', import.meta.url), 'utf8');
const tray = readFileSync(new URL('../src-tauri/src/tray.rs', import.meta.url), 'utf8');

test('시작과 종료 출석 알림 설정을 위아래 두 행으로 배치한다', () => {
    const schedulesStart = onboarding.indexOf('<div class="grid min-h-0 flex-1', onboarding.indexOf('onboarding-notification-title'));
    const schedulesOpeningTagEnd = onboarding.indexOf('>', schedulesStart);
    const schedulesOpeningTag = onboarding.slice(schedulesStart, schedulesOpeningTagEnd);

    assert.ok(schedulesStart >= 0);
    assert.match(schedulesOpeningTag, /\bgrid-rows-2\b/);
    assert.doesNotMatch(schedulesOpeningTag, /\bgrid-cols-2\b/);
});

test('560x720 Tauri 창에서 알림 일정 카드의 컨트롤이 테두리 안에 들어오도록 압축한다', () => {
    const schedulesMarker = onboarding.indexOf('data-ui="notification-schedules"');
    const schedulesStart = onboarding.lastIndexOf('<div', schedulesMarker);
    const schedulesEnd = onboarding.indexOf('</section>', schedulesStart);
    const schedules = onboarding.slice(schedulesStart, schedulesEnd);

    assert.match(tray, /const UTILITY_WINDOW_WIDTH: f64 = 560\.0;/);
    assert.match(tray, /const STANDARD_WINDOW_HEIGHT: f64 = 720\.0;/);
    assert.ok(schedulesMarker >= 0);
    assert.ok(schedulesStart >= 0);
    assert.match(schedules, /\bgap-3\b/);
    assert.equal(schedules.match(/<label class="flex min-h-10\b/g)?.length, 2);
    assert.equal(schedules.match(/<button[^>]*class="[^"]*\bmin-h-10\b[^"]*"[^>]*role="combobox"/g)?.length, 4);
});
