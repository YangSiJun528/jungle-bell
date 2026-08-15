import {readFileSync} from 'node:fs';
import {renderToStaticMarkup} from 'react-dom/server';
import {createMemoryHistory, RouterContextProvider} from '@tanstack/react-router';
import {describe, expect, test, vi} from 'vitest';

import {
    DASHBOARD_ROUTE_META,
    dashboardNavigationRoutes,
    dashboardRouteFromHash,
    dashboardRouteHref,
    dashboardRoutePath,
    dashboardUtilityRoutes,
} from '../routes';
import {DashboardShell} from './DashboardShell';
import {createDashboardRouter} from '../dashboard-router';

const shellSource = readFileSync(new URL('./DashboardShell.tsx', import.meta.url), 'utf8');

function renderShell(shell: React.ReactNode): string {
    const router = createDashboardRouter(createMemoryHistory({initialEntries: ['/home']}));
    return renderToStaticMarkup(
        <RouterContextProvider router={router}>{shell}</RouterContextProvider>,
    );
}

describe('dashboard routes', () => {
    test('browser and desktop expose the same SPA navigation', () => {
        expect(dashboardNavigationRoutes()).toEqual(['home', 'attendance', 'laundry', 'meals']);
        expect(dashboardNavigationRoutes()).toEqual(['home', 'attendance', 'laundry', 'meals']);
        expect(dashboardRouteFromHash('#/attendance')).toBe('attendance');
        expect(dashboardRouteFromHash('#/laundry')).toBe('laundry');
    });

    test('personal primary navigation excludes notification and settings utilities', () => {
        expect(dashboardNavigationRoutes()).toEqual([
            'home',
            'attendance',
            'laundry',
            'meals',
        ]);
        expect(dashboardNavigationRoutes()).toEqual([
            'home',
            'attendance',
            'laundry',
            'meals',
        ]);
        expect(dashboardUtilityRoutes()).toEqual(['notifications', 'connections']);
        expect(dashboardUtilityRoutes()).toEqual(['notifications', 'connections']);
        expect(dashboardNavigationRoutes()).not.toContain('notifications');
        expect(dashboardNavigationRoutes()).not.toContain('connections');
        expect(dashboardRouteFromHash('#/notifications')).toBe('notifications');
        expect(dashboardRouteHref('notifications')).toBe('#/notifications');
        expect(dashboardRouteHref('connections')).toBe('#/connections');
        expect(dashboardRoutePath('connections')).toBe('/connections');
        expect(DASHBOARD_ROUTE_META.home).toEqual({label: '홈', shortLabel: '홈'});
        expect(DASHBOARD_ROUTE_META.meals).toEqual({label: '식단', shortLabel: '식단'});
        expect(DASHBOARD_ROUTE_META.notifications.label).toBe('알림');
        expect(DASHBOARD_ROUTE_META.connections.label).toBe('설정');
    });
});

describe('DashboardShell', () => {
    test('renders the shared browser shell, top spacer, and project footer', () => {
        const html = renderShell(
            <DashboardShell
                platform="browser"
                activeRoute="home"
                navigate={vi.fn()}
                unreadCount={0}
            >
                <section data-page-content>공개 홈</section>
            </DashboardShell>,
        );

        expect(html).toContain('data-dashboard-shell="renewal"');
        expect(html).toContain('data-dashboard-platform="browser"');
        expect(html).toContain('data-dashboard-route="laundry"');
        expect(html).toContain('data-dashboard-route="attendance"');
        expect(html).toContain('data-dashboard-route="notifications"');
        expect(html).toContain('data-dashboard-route="connections"');
        expect(html).toContain('data-slot="sidebar"');
        expect(html).toContain('--sidebar-width:16rem');
        expect(html).toContain('data-sidebar-resizable="true"');
        expect(html).toContain('data-resizable="true"');
        expect(html).toContain('aria-label="사이드바 크기 조절"');
        expect(html).not.toContain('type="range"');
        expect(html).not.toContain('aria-label="사이드바 너비"');
        expect(html).toContain('border-t border-sidebar-border');
        expect((html.match(/data-sidebar="trigger"/g) ?? [])).toHaveLength(2);
        expect(html).toContain('aria-label="사이드바 메뉴 열기"');
        expect(html).toContain('data-sidebar="rail"');
        expect(html).toContain('data-shell-top-spacer="true"');
        expect((html.match(/max-w-6xl/g) ?? []).length).toBe(2);
        expect(html).not.toContain('<header');
        expect(html).not.toContain('Jungle Bell은 정글 캠퍼스 생활 정보를 한곳에 모아 보여주는 오픈소스 프로젝트입니다.');
        expect(html).toContain('href="https://github.com/YangSiJun528/jungle-bell"');
        expect(html).toContain('href="https://github.com/YangSiJun528/jungle-bell/discussions/categories/');
        expect(html).toContain('href="https://github.com/YangSiJun528/jungle-bell/releases/latest"');
        expect(html).toContain('공개 홈');
    });

    test('renders notification panel trigger, settings, and the standard sidebar controls', () => {
        const html = renderShell(
            <DashboardShell
                platform="browser"
                activeRoute="notifications"
                navigate={vi.fn()}
                unreadCount={120}
            >
                <section>알림 목록</section>
            </DashboardShell>,
        );

        expect(html).toContain('data-dashboard-route="attendance"');
        expect(html).toContain('data-dashboard-route="notifications"');
        expect(html).toContain('data-dashboard-route="connections"');
        expect(html).toContain('data-navigation-group="utilities"');
        expect(html).toContain('aria-label="개인 도구"');
        expect(html).toContain('aria-label="알림, 읽지 않은 알림 120개"');
        expect(html).toContain('aria-haspopup="dialog"');
        expect(html).toContain('aria-expanded="true"');
        expect((html.match(/data-slot="sheet-trigger"/g) ?? [])).toHaveLength(2);
        expect(html).toContain('aria-label="설정"');
        expect(html).toContain('href="/connections"');
        expect(html).toContain('data-unread="true"');
        expect(html).toContain('data-slot="sidebar-menu-badge"');
        expect(html).toMatch(/data-slot="sidebar-menu-badge"[^>]*aria-hidden="true"[^>]*>120<\/div>/u);
        expect(html).toMatch(/data-slot="sidebar-menu-badge"[^>]*class="[^"]*top-1\/2![^"]*-translate-y-1\/2!/u);
        expect(html).toContain('grid-template-columns:repeat(4, minmax(0, 1fr))');
        expect(html).toContain('사이드바 접기');
        expect(html).not.toContain('사이드바 펼치기');
        expect((html.match(/data-sidebar="trigger"/g) ?? [])).toHaveLength(2);
        expect(html).toContain('data-sidebar="rail"');
        expect(html).toContain('data-shell-top-spacer="true"');
        expect(html).toContain('border-t border-sidebar-border');
    });

    test('shows the exact unread count in the sidebar and omits the badge at zero', () => {
        const unreadHtml = renderShell(
            <DashboardShell
                platform="desktop"
                activeRoute="home"
                navigate={vi.fn()}
                unreadCount={7}
            >
                <section>홈</section>
            </DashboardShell>,
        );
        const readHtml = renderShell(
            <DashboardShell
                platform="desktop"
                activeRoute="home"
                navigate={vi.fn()}
                unreadCount={0}
            >
                <section>홈</section>
            </DashboardShell>,
        );

        expect(unreadHtml).toMatch(/data-slot="sidebar-menu-badge"[^>]*>7<\/div>/u);
        expect(readHtml).not.toContain('data-slot="sidebar-menu-badge"');
    });

    test('uses the canonical compass image for the Jungle Bell brand', () => {
        const html = renderShell(
            <DashboardShell
                platform="browser"
                activeRoute="home"
                navigate={vi.fn()}
                unreadCount={0}
            >
                <section>홈</section>
            </DashboardShell>,
        );

        expect(html).toContain('<img');
        expect(html).toContain('logo.png');
        expect(html).toContain('hover:bg-transparent!');
        expect(html).toContain('active:bg-transparent!');
        expect(html).not.toContain('Jungle Bell 홈</span>');
    });

    test('notification content uses a modal side panel that closes through open state changes', () => {
        expect(shellSource).toContain('<Sheet open={notificationPanelOpen} onOpenChange={onNotificationPanelOpenChange}>');
        expect((shellSource.match(/<SheetTrigger asChild>/gu) ?? [])).toHaveLength(2);
        expect(shellSource).toContain('const notificationTriggerRef = useRef<HTMLButtonElement | null>(null);');
        expect(shellSource).toContain('notificationTriggerRef.current = trigger;');
        expect(shellSource).toContain('onNotificationPanelOpenChange(true);');
        expect(shellSource).toContain('onTriggerClick={rememberNotificationTrigger}');
        expect(shellSource).toContain('onClick={(event) => rememberNotificationTrigger(event.currentTarget)}');
        expect(shellSource).toContain('onCloseAutoFocus={(event) => {');
        expect(shellSource).toContain('notificationTriggerRef.current?.focus();');
        expect(shellSource).toContain("document.getElementById('dashboard-content')?.focus();");
        expect(shellSource).toContain('side="right"');
        expect(shellSource).toContain('overlayClassName="backdrop-blur-sm"');
        expect(shellSource).toContain('data-notification-panel="true"');
        expect(shellSource).toContain('<SheetTitle>알림</SheetTitle>');
        expect(shellSource).not.toContain('keyboardShortcut={null}');
    });
});
