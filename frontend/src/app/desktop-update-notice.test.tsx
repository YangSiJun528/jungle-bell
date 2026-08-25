import {readFileSync} from 'node:fs';

import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, test, vi} from 'vitest';

import type {DesktopSettings} from '@/platform/contracts';

import {DesktopUpdateNotice} from './desktop-update-notice';

const source = readFileSync(new URL('./desktop-update-notice.tsx', import.meta.url), 'utf8');
const {environment, queryKeys} = vi.hoisted(() => ({
    queryKeys: {
        desktopSettings: ['desktop-settings'] as const,
        desktopUpdate: ['desktop-update'] as const,
    },
    environment: {
        api: {
            getDesktopSettings: vi.fn<() => Promise<DesktopSettings>>(),
            checkDesktopUpdate: vi.fn<() => Promise<unknown>>(),
            installDesktopUpdate: vi.fn<() => Promise<void>>(),
        },
        platform: {kind: 'desktop', capabilities: {desktopSettings: true}},
    },
}));

vi.mock('@/app/dashboard-context', () => ({
    queryKeys,
    useDashboardEnvironment: () => environment,
}));

const settings: DesktopSettings = {
    appVersion: '0.5.0',
    autoStart: true,
    autoUpdate: false,
    usageAnalytics: false,
    usageAnalyticsSyncPending: false,
    debugMode: false,
    selectedCohortId: null,
    effectiveCohortId: null,
    cohortOptions: [],
};

function renderNotice(options: {autoUpdate: boolean; availableVersion: string | null}): string {
    const client = new QueryClient();
    client.setQueryData(queryKeys.desktopSettings, {
        ...settings,
        autoUpdate: options.autoUpdate,
    });
    client.setQueryData(queryKeys.desktopUpdate, {
        currentVersion: '0.5.0',
        availableVersion: options.availableVersion,
        mandatory: false,
    });
    return renderToStaticMarkup(
        <QueryClientProvider client={client}>
            <DesktopUpdateNotice />
        </QueryClientProvider>,
    );
}

describe('DesktopUpdateNotice', () => {
    test('자동 업데이트가 꺼진 구버전에 안내와 수동 설치 버튼을 표시한다', () => {
        const markup = renderNotice({autoUpdate: false, availableVersion: '0.5.1'});

        expect(markup).toContain('업데이트가 필요합니다.');
        expect(markup).toContain('현재 v0.5.0');
        expect(markup).toContain('최신 v0.5.1');
        expect(markup).toContain('지금 업데이트');
        expect(source).toContain('api.installDesktopUpdate()');
    });

    test('자동 업데이트가 켜졌거나 최신 버전이면 안내를 숨긴다', () => {
        expect(renderNotice({autoUpdate: true, availableVersion: '0.5.1'})).toBe('');
        expect(renderNotice({autoUpdate: false, availableVersion: null})).toBe('');
    });
});
