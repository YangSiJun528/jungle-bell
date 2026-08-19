import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, test, vi} from 'vitest';
import type {DesktopSettings} from '@/platform/contracts';
import {ServiceSettings} from './service-settings';

const source = readFileSync(new URL('./service-settings.tsx', import.meta.url), 'utf8');

const {api, environment, queryKeys} = vi.hoisted(() => ({
    api: {
        getDesktopSettings: vi.fn(),
        updateDesktopSettings: vi.fn(),
        openLogFolder: vi.fn(),
    },
    environment: {platform: {capabilities: {desktopSettings: true}}},
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
    selectedCohortId: null,
    effectiveCohortId: 'cohort-1',
    cohortOptions: [{
        id: 'cohort-1',
        label: '정글 10기',
        startDate: '2026-07-01',
        endDate: '2026-08-31',
        isActive: true,
    }],
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
        expect(source).toContain('디버그 모드를 켤까요?');
        expect(source).toContain('특별한 목적이 없다면 켜지 마세요.');
        expect(source).toContain('네, 디버그 모드 켜기');
        expect(source).toContain("if (checked) setConfirmDebugOn(true)");
        expect(markup).toContain('출석·식단 내용과 LMS 계정 정보는 전송하지 않습니다.');
        expect(markup).toContain('개발자 도구나 외부 명령 실행 권한은 열지 않습니다.');
        expect(markup).toContain('출석 확인 기수');
        expect(markup).toContain('자동 선택');
        expect(source).toContain('{cohort.label}');
        expect(markup).toContain('변경사항 적용');
        expect(source).toContain("setCohortDraft(value === 'automatic' ? null : value)");
        expect(source).toContain('updateSelectedCohort(cohortDraft)');
        expect(source).not.toContain("onValueChange={(value) => updateSelectedCohort");
    });

    test('모바일에서는 PC 로컬 설정을 편집하지 않는다', () => {
        environment.platform = {capabilities: {desktopSettings: false}};
        try {
            const markup = renderSettings();
            expect(markup).toContain('PC 앱에서 설정합니다.');
            expect(markup).not.toContain('aria-label="자동 시작"');
        } finally {
            environment.platform = {capabilities: {desktopSettings: true}};
        }
    });
});
import {readFileSync} from 'node:fs';
