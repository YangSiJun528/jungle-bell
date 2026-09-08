import {readFileSync} from 'node:fs';

import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, test, vi} from 'vitest';

import {DesktopUpdateNotice} from './desktop-update-notice';

const source = readFileSync(new URL('./desktop-update-notice.tsx', import.meta.url), 'utf8');
const {environment, queryKeys} = vi.hoisted(() => ({
    queryKeys: {
        desktopUpdate: ['desktop-update'] as const,
    },
    environment: {
        api: {
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

function renderNotice(options: {availableVersion: string | null; mandatory?: boolean}): string {
    const client = new QueryClient();
    client.setQueryData(queryKeys.desktopUpdate, {
        currentVersion: '0.5.0',
        availableVersion: options.availableVersion,
        mandatory: options.mandatory ?? false,
    });
    return renderToStaticMarkup(
        <QueryClientProvider client={client}>
            <DesktopUpdateNotice />
        </QueryClientProvider>,
    );
}

describe('DesktopUpdateNotice', () => {
    test('일반 patch 업데이트가 있으면 설정과 무관하게 비차단 안내와 수동 설치 버튼을 표시한다', () => {
        const markup = renderNotice({availableVersion: '0.5.1'});

        expect(markup).toContain('업데이트가 필요합니다.');
        expect(markup).toContain('현재 v0.5.0');
        expect(markup).toContain('최신 v0.5.1');
        expect(markup).toContain('지금 업데이트');
        expect(source).toContain('api.installDesktopUpdate()');
    });

    test('최신 버전이거나 강제 업데이트면 일반 안내를 숨긴다', () => {
        expect(renderNotice({availableVersion: null})).toBe('');
        expect(renderNotice({availableVersion: '0.6.0', mandatory: true})).toBe('');
    });
});
