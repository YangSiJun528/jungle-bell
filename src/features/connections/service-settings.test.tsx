import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, test, vi} from 'vitest';
import type {DesktopSettings} from '@/api/desktop-settings';
import {ServiceSettings} from './service-settings';

const {api, environment, queryKeys} = vi.hoisted(() => ({
    api: {
        getDesktopSettings: vi.fn(),
        updateDesktopSettings: vi.fn(),
        openLogFolder: vi.fn(),
    },
    environment: {surface: {kind: 'desktop'}},
    queryKeys: {desktopSettings: ['desktop-settings'] as const},
}));

vi.mock('@/app/dashboard-context', () => ({
    queryKeys,
    useDashboardEnvironment: () => ({api, ...environment}),
}));

const settings: DesktopSettings = {
    autoStart: true,
    autoUpdate: true,
    usageAnalytics: true,
    debugMode: false,
};

function renderSettings(): string {
    const client = new QueryClient();
    client.setQueryData(queryKeys.desktopSettings, settings);
    return renderToStaticMarkup(
        <QueryClientProvider client={client}>
            <ServiceSettings/>
        </QueryClientProvider>,
    );
}

describe('ServiceSettings', () => {
    test('데스크톱 로컬 기능을 실제 설정 컨트롤로 표시한다', () => {
        const markup = renderSettings();
        for (const label of ['자동 시작', '자동 업데이트', '사용 통계', '디버그 모드']) {
            expect(markup).toContain(`aria-label="${label}"`);
        }
        expect(markup).toContain('로그 폴더');
        expect(markup).toContain('설치 식별자의 일방향 해시');
        expect(markup).toContain('출석·식단 내용과 LMS 계정 정보는 전송하지 않습니다.');
        expect(markup).toContain('개발자 도구나 외부 명령 실행 권한은 열지 않습니다.');
    });

    test('모바일에서는 PC 로컬 설정을 편집하지 않는다', () => {
        environment.surface = {kind: 'companion'};
        try {
            const markup = renderSettings();
            expect(markup).toContain('PC 앱에서 설정합니다.');
            expect(markup).not.toContain('aria-label="자동 시작"');
        } finally {
            environment.surface = {kind: 'desktop'};
        }
    });
});
