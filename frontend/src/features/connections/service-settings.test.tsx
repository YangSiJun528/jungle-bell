import {readFileSync} from 'node:fs';

import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, test, vi} from 'vitest';

import type {DesktopSettings} from '@/platform/contracts';

import {ServiceSettings} from './service-settings';

const source = readFileSync(new URL('./service-settings.tsx', import.meta.url), 'utf8');
const normalizedSource = source.replace(/\s+/gu, ' ');

const {api, environment, queryKeys} = vi.hoisted(() => ({
    api: {
        getDesktopSettings: vi.fn<() => Promise<DesktopSettings>>(),
        updateDesktopSettings:
            vi.fn<(input: Partial<DesktopSettings>) => Promise<DesktopSettings>>(),
        openLogFolder: vi.fn<() => Promise<void>>(),
    },
    environment: {platform: {capabilities: {desktopSettings: true}}},
    queryKeys: {desktopSettings: ['desktop-settings'] as const},
}));

vi.mock('@/app/dashboard-context', () => ({
    queryKeys,
    useDashboardEnvironment: () => ({api, ...environment}),
}));

const settings: DesktopSettings = {
    appVersion: '0.5.0-beta.1',
    autoStart: true,
    autoUpdate: true,
    usageAnalytics: null,
    usageAnalyticsSyncPending: false,
    debugMode: false,
    selectedCohortId: null,
    effectiveCohortId: 'cohort-1',
    cohortOptions: [
        {
            id: 'cohort-1',
            label: '정글 10기',
            startDate: '2026-07-01',
            endDate: '2026-08-31',
            isActive: true,
        },
    ],
};

function renderSettings(value: DesktopSettings = settings): string {
    const client = new QueryClient();
    client.setQueryData(queryKeys.desktopSettings, value);
    return renderToStaticMarkup(
        <QueryClientProvider client={client}>
            <ServiceSettings />
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
        expect(markup).toContain('앱 버전');
        expect(markup).toContain('v0.5.0-beta.1');
        expect(source).toContain('디버그 모드를 켤까요?');
        expect(normalizedSource).toContain('특별한 목적이 없다면 켜지 마세요.');
        expect(source).toContain('네, 디버그 모드 켜기');
        expect(source).toContain('if (checked) setConfirmDebugOn(true)');
        expect(markup).toContain(
            '기존 선택을 확인할 수 없어 이 PC와 연결된 PWA 모두 전송하지 않습니다.',
        );
        expect(markup).toContain('이 PC와 이 계정에 연결된 PWA에 같은 설정이 적용됩니다.');
        expect(markup).toMatch(/<button[^>]+aria-checked="false"[^>]+aria-label="사용 통계"/u);
        expect(markup).toContain('개발자 도구나 외부 명령 실행 권한은 열지 않습니다.');
        expect(markup).toContain('출석 확인 기수');
        expect(markup).toContain('자동 선택');
        expect(source).toContain('{cohort.label}');
        expect(markup).toContain('변경사항 적용');
        expect(source).toContain("setCohortDraft(nextValue === 'automatic' ? null : nextValue)");
        expect(source).toContain('updateSelectedCohort(cohortDraft)');
        expect(source).not.toContain('onValueChange={(value) => updateSelectedCohort');
    });

    test('사용 통계를 명시적으로 허용한 설정만 켜진 상태로 표시한다', () => {
        const markup = renderSettings({...settings, usageAnalytics: true});
        expect(markup).toMatch(/<button[^>]+aria-checked="true"[^>]+aria-label="사용 통계"/u);
        expect(markup).not.toContain('기존 선택을 확인할 수 없어');
    });

    test('계정 설정 동기화가 끝나기 전에는 실제 전송 범위를 구분해 안내한다', () => {
        const enabling = renderSettings({
            ...settings,
            usageAnalytics: true,
            usageAnalyticsSyncPending: true,
        });
        expect(enabling).toContain('서버에서 허용을 확인하기 전까지 전송하지 않습니다.');

        const disabling = renderSettings({
            ...settings,
            usageAnalytics: false,
            usageAnalyticsSyncPending: true,
        });
        expect(disabling).toContain('이 PC의 전송은 중지했습니다.');
        expect(disabling).toContain('연결된 PWA의 계정 설정은 서버 연결 후 적용됩니다.');

        const undecided = renderSettings({...settings, usageAnalyticsSyncPending: true});
        expect(undecided).toContain('이 PC에서는 전송하지 않습니다.');
        expect(undecided).toContain('연결된 PWA의 계정 설정은 서버 연결 후 확인됩니다.');
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
