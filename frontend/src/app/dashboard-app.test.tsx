import {readFileSync} from 'node:fs';

import {describe, expect, test} from 'vitest';

const source = readFileSync(new URL('./dashboard-app.tsx', import.meta.url), 'utf8');

describe('DashboardApp personal access boundaries', () => {
    test('공유 shell 내부의 route content에만 인증 gate를 둔다', () => {
        const shellStart = source.indexOf('<DashboardShell');
        const shellEnd = source.indexOf('</DashboardShell>');
        const gate = source.indexOf('<PlatformAuthenticationGate', shellStart);

        expect(shellStart).toBeGreaterThan(-1);
        expect(gate).toBeGreaterThan(shellStart);
        expect(gate).toBeLessThan(shellEnd);
        expect(source).toMatch(
            /<PlatformAuthenticationGate[\s\S]*enabled=\{isPersonalDashboardRoute\(contentRoute\)\}[\s\S]*<Outlet\s*\/>/u,
        );
        expect(source).toContain('preserveRouteHeading');
    });

    test('privacy route는 dashboard shell 밖의 공개 outlet을 보존한다', () => {
        expect(source).toContain(
            "{pathname === '/privacy' ? <PublicRouteOutlet /> : <DashboardContent />}",
        );
    });

    test('알림 panel 내용 자체도 항상 개인 인증 gate를 통과한다', () => {
        const panelStart = source.indexOf('notificationPanel={{');
        const panelContent = source.slice(
            panelStart,
            source.indexOf('<DashboardRouteRuntimeProvider', panelStart),
        );

        expect(panelContent).toMatch(
            /<PlatformAuthenticationGate enabled>[\s\S]*<NotificationPanelContent/u,
        );
    });

    test('route 제목과 H1 포커스를 공통 accessibility controller에 위임한다', () => {
        expect(source).toContain('<DashboardRouteAccessibility pathname={pathname} />');
    });

    test('route AsyncBoundary 오류 fallback에도 현재 route PageHeader를 유지한다', () => {
        expect(source).toContain(
            '<DashboardRouteErrorFallback route={contentRoute} retry={retry} />',
        );
        expect(source).toMatch(/<AsyncBoundary[\s\S]*renderError=\{/u);
    });

    test('PC 설정 화면에 종료 동작 요약을 실제 mount한다', () => {
        expect(source).toMatch(
            /platform\.kind === 'desktop' && contentRoute === 'connections'[\s\S]*<DesktopLifecycleSummary/u,
        );
    });
});
