import {readFileSync} from 'node:fs';

import {describe, expect, test} from 'vitest';

const pageSource = readFileSync(new URL('./app-status-page.tsx', import.meta.url), 'utf8');
const panelSource = readFileSync(new URL('./app-status-panel.tsx', import.meta.url), 'utf8');
const rowSource = readFileSync(new URL('./app-status-row.tsx', import.meta.url), 'utf8');
const pwaSource = readFileSync(new URL('./connected-pwa-status.tsx', import.meta.url), 'utf8');

describe('AppStatusPage', () => {
    test('상태 행마다 상태 텍스트, 복구 동작, polite live feedback을 제공한다', () => {
        expect(rowSource).toContain('aria-live="polite"');
        expect(rowSource).toContain('row.action');
        expect(panelSource).toContain('AppStatusRow');
        expect(panelSource).toContain('앱 상태');
    });

    test('실제 입력이 없으면 producer에 연결된 상태를 렌더링한다', () => {
        expect(pageSource).toContain('if (input)');
        expect(pageSource).toContain('<ConnectedAppStatus');
        expect(pwaSource).toContain('loadPushSubscriptionReconciliation({');
        expect(pwaSource).toContain('notificationPermissionFromRuntime');
        expect(pwaSource).toContain('readNotificationTestRecord');
        expect(pwaSource).toContain('serviceWorkerObservation(');
    });
});
