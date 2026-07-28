import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'vitest';

import {
    ALERT_OVERLAY_UPDATED_EVENT,
    normalizeAlertOverlaySnapshot,
} from './alert-overlay';

const html = readFileSync(new URL('./alert-overlay.html', import.meta.url), 'utf8');
const source = readFileSync(new URL('./alert-overlay.ts', import.meta.url), 'utf8');
const capability = JSON.parse(
    readFileSync(new URL('../src-tauri/capabilities/alert-overlay.json', import.meta.url), 'utf8'),
) as {permissions: string[]};
const templateStart = html.indexOf('<template data-alert-item-template>');
const templateEnd = html.indexOf('</template>', templateStart);
const itemTemplate = html.slice(templateStart, templateEnd);

test('알림 창 snapshot은 유효한 revision과 메시지만 허용한다', () => {
    assert.deepEqual(
        normalizeAlertOverlaySnapshot({
            revision: 2,
            alerts: [{
                id: '7',
                title: '세탁 완료',
                body: '3번 세탁기의 세탁이 끝났습니다.',
                action: 'openLaundry',
            }],
        }),
        {
            revision: 2,
            alerts: [{
                id: '7',
                title: '세탁 완료',
                body: '3번 세탁기의 세탁이 끝났습니다.',
                action: 'openLaundry',
            }],
        },
    );
    assert.equal(normalizeAlertOverlaySnapshot({revision: -1, alerts: []}), null);
    assert.equal(normalizeAlertOverlaySnapshot({revision: 1, alerts: [{id: '', title: '제목', body: '본문'}]}), null);
    assert.equal(normalizeAlertOverlaySnapshot({revision: 1, alerts: [{id: '1', title: 3, body: '본문'}]}), null);
    assert.equal(
        normalizeAlertOverlaySnapshot({
            revision: 1,
            alerts: [{id: '1', title: '제목', body: '본문', action: 'unknown'}],
        }),
        null,
    );
});

test('알림 센터는 자동 종료 없이 사용자가 선택한 알림만 제거한다', () => {
    assert.equal(ALERT_OVERLAY_UPDATED_EVENT, 'alert-overlay-updated');
    assert.match(source, /listen<AlertOverlaySnapshot>\(ALERT_OVERLAY_UPDATED_EVENT/);
    assert.match(source, /invoke<AlertOverlaySnapshot>\('get_alert_overlay_snapshot'\)/);
    assert.match(source, /invoke<AlertOverlaySnapshot>\('dismiss_alert_overlay',\s*\{id(?:\s*:|\s*\})/);
    assert.doesNotMatch(source, /setTimeout|visibilitychange|onFocusChanged|blur/);
    assert.match(html, /aria-label="Jungle Bell 알림 센터"/);
    assert.match(html, /aria-live="assertive"/);
    assert.match(html, /aria-label="알림 닫기"/);
});

test('여러 알림을 목록으로 모두 표시하고 각 알림을 따로 닫는다', () => {
    assert.match(html, /data-alert-list/);
    assert.match(html, /data-alert-item-template/);
    assert.match(html, /data-alert-item-title/);
    assert.match(html, /data-alert-item-body/);
    assert.match(html, /data-alert-item-close/);
    assert.match(html, /data-alert-total/);
    assert.match(source, /for \(const alert of alerts\)/);
    assert.match(source, /template\.content\.cloneNode\(true\)/);
    assert.match(source, /alert\.id/);
    assert.doesNotMatch(source, /alerts\[0\]/);
});

test('알림을 선택하면 관련 창으로 이동하고 해당 항목을 제거한다', () => {
    assert.match(html, /data-alert-item-open/);
    assert.match(source, /invoke<AlertOverlaySnapshot>\('activate_alert_overlay',\s*\{id(?:\s*:|\s*\})/);
    assert.match(source, /open\.setAttribute\('aria-label', `\$\{alert\.title\} 알림 열기`\)/);
    assert.ok(capability.permissions.includes('allow-activate-alert-overlay'));
});

test('알림 센터는 하나의 둥근 표면 안에서 평면 목록으로 알림을 구분한다', () => {
    assert.match(html, /html,\s*body\s*\{[\s\S]*?background:\s*transparent\s*!important/);
    assert.match(html, /rounded-2xl[^"]*border[^"]*border-app-border[^"]*bg-app-overlay[^"]*"[\s\S]*data-alert-center/);
    assert.match(html, /divide-y[^"]*divide-app-divider[^"]*"[\s\S]*data-alert-list/);
    assert.match(html, /m-0[^"]*p-0[^"]*"[\s\S]*data-alert-list/);
    assert.match(itemTemplate, /min-h-\[84px\]/);
    assert.match(itemTemplate, /bg-transparent/);
    assert.match(itemTemplate, /hover:bg-app-surface-subtle/);
    assert.doesNotMatch(itemTemplate, /rounded-xl|border-app-border|bg-app-overlay|shadow-sm|inset-y-3/);
    assert.doesNotMatch(html, /space-y-2|px-2 pb-2/);
    assert.match(html, /\[data-alert-list\]::\-webkit-scrollbar\s*\{[\s\S]*?width:\s*6px/);
});

test('헤더와 닫기 동작은 장식보다 정보와 조작을 우선한다', () => {
    assert.match(html, /data-alert-total[^>]*>0개<\/span>/);
    assert.doesNotMatch(html, /data-alert-total>알림 0개<\/span>/);
    assert.match(itemTemplate, /data-icon="close"/);
    assert.match(itemTemplate, /rounded-full[^"]*border-0[^"]*bg-transparent/);
    assert.doesNotMatch(html, /alert-overlay-glow|animate-pulse|border-2 border-app-warning/);
});

test('헤더를 드래그해 알림 창을 옮길 수 있다', () => {
    assert.match(html, /<header[^>]*data-tauri-drag-region/);
    assert.ok(capability.permissions.includes('core:window:allow-start-dragging'));
});

test('유지 방식에 대한 중복 설명을 표시하지 않는다', () => {
    assert.doesNotMatch(html, /확인할 때까지|유지됩니다/);
    assert.doesNotMatch(source, /확인할 때까지|유지됩니다/);
});
