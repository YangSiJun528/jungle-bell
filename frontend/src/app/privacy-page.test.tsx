import {readFileSync} from 'node:fs';

import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {createMemoryHistory, RouterContextProvider} from '@tanstack/react-router';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, test, vi} from 'vitest';

import {unavailablePwaAdapter, type UsagePrivacyAdapter} from '@/platform/contracts';
import {createWebPlatformAdapter} from '@/platform/web/adapter';

import {createEnvironment, DashboardEnvironmentContext} from './dashboard-context';
import {createDashboardRouter} from './dashboard-router';
import {PrivacyPage} from './privacy-page';

const dashboardSource = readFileSync(new URL('./dashboard-app.tsx', import.meta.url), 'utf8');

function renderPrivacyPage(): string {
    vi.stubGlobal('window', {
        fetch: vi.fn<typeof fetch>(),
        location: {origin: 'https://example.test', protocol: 'https:'},
    });
    const router = createDashboardRouter(createMemoryHistory({initialEntries: ['/privacy']}));
    const usagePrivacy: UsagePrivacyAdapter = {
        available: true,
        get: async () => ({enabled: false, scope: 'anonymous'}),
        update: async (enabled) => ({enabled, scope: 'anonymous'}),
        allowsAnonymousReporting: () => false,
    };
    const environment = createEnvironment(
        createWebPlatformAdapter(unavailablePwaAdapter(), usagePrivacy),
    );
    return renderToStaticMarkup(
        <QueryClientProvider client={new QueryClient()}>
            <DashboardEnvironmentContext.Provider value={environment}>
                <RouterContextProvider router={router}>
                    <PrivacyPage />
                </RouterContextProvider>
            </DashboardEnvironmentContext.Provider>
        </QueryClientProvider>,
    );
}

describe('개인정보 처리방침', () => {
    test('공개 문서에 버전과 필수 처리 항목을 표시한다', () => {
        const markup = renderPrivacyPage();

        expect(markup).toContain('개인정보 처리방침');
        expect(markup).toContain('시행일: 2026-08-25');
        expect(markup).toContain('버전: 1.2');
        expect(markup).toContain('1. 개인정보의 처리 목적');
        expect(markup).toContain('2. 수집하는 개인정보 항목');
        expect(markup).toContain('필수 항목');
        expect(markup).toContain('IP 주소, 쿠키, 기기정보, 서비스 이용기록');
        expect(markup).toContain('정식 배포된 Web·PWA와 PC 앱에서만 전송');
        expect(markup).toContain('회원 탈퇴 또는 연결 계정 삭제 시까지');
        expect(markup).toContain('4. 사용 통계 설정과 수집 거부');
        expect(markup).toContain('aria-label="익명 방문 통계 수집"');
        expect(markup).toContain('일별 집계 결과는 설정 변경을 이유로 역으로 삭제하지');
        expect(markup).toContain('개인정보 보호책임자');
        expect(markup).toContain('양시준');
        expect(markup).toContain('href="mailto:yangsijun5528@gmail.com"');
        expect(markup).toContain('변경 고지 방법: 앱 내 공지');
    });

    test('통계 식별 단위와 계정 설정 정책을 실제 동작대로 고지한다', () => {
        const markup = renderPrivacyPage();

        expect(markup).toContain('실제 사람 수로 해석할 수 없습니다');
        expect(markup).toContain('installation identity(UUID)');
        expect(markup).toContain('사용 통계는 그 서버 계정 UUID를 셉니다');
        expect(markup).toContain('href="/connections"');
        expect(markup).toContain('설정 → 개인정보');
        expect(markup).toContain('아직 선택하지 않은 상태에서는 사용 통계를 수집하지 않습니다');
        expect(markup).toContain('과거에 명시적으로 거부한 설정은 그대로 유지');
        expect(markup).toContain('기존 선택을 복원할 수 없는 설치');
        expect(markup).toContain('완전 신규 설치만');
        expect(markup).toContain('계정 사용 통계 설정과는 별도로 저장');
    });

    test('대시보드에서 개인정보 확인 안내를 자동 노출하지 않는다', () => {
        expect(dashboardSource).not.toContain('UsagePrivacyNotice');
        expect(dashboardSource).not.toContain('usage-privacy-notice');
    });
});
