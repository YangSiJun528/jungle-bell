import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, test, vi} from 'vitest';

import {
    dashboardNavigationRoutes,
    dashboardRouteFromHash,
    dashboardRouteHref,
    dashboardUtilityRoutes,
} from '../routes';
import {DashboardShell} from './DashboardShell';

describe('dashboard routes', () => {
    test('public surfaces only expose public information', () => {
        expect(dashboardNavigationRoutes('public', 'sidebar')).toEqual(['home', 'laundry', 'meals']);
        expect(dashboardNavigationRoutes('public', 'bottom')).toEqual(['home', 'laundry', 'meals']);
        expect(dashboardRouteFromHash('#attendance', 'public')).toBe('home');
        expect(dashboardRouteFromHash('#laundry', 'public')).toBe('laundry');
    });

    test('personal primary navigation excludes notification and connection utilities', () => {
        expect(dashboardNavigationRoutes('companion', 'bottom')).toEqual([
            'home',
            'attendance',
            'laundry',
            'meals',
        ]);
        expect(dashboardNavigationRoutes('desktop', 'sidebar')).toEqual([
            'home',
            'attendance',
            'laundry',
            'meals',
        ]);
        expect(dashboardUtilityRoutes('desktop')).toEqual(['notifications', 'connections']);
        expect(dashboardUtilityRoutes('companion')).toEqual(['notifications', 'connections']);
        expect(dashboardUtilityRoutes('public')).toEqual([]);
        expect(dashboardNavigationRoutes('desktop', 'sidebar')).not.toContain('notifications');
        expect(dashboardNavigationRoutes('desktop', 'bottom')).not.toContain('connections');
        expect(dashboardRouteFromHash('#notifications', 'companion')).toBe('notifications');
        expect(dashboardRouteHref('notifications')).toBe('#notifications');
        expect(dashboardRouteHref('connections')).toBe('#connections');
    });
});

describe('DashboardShell', () => {
    test('renders a collapsible public shell, top spacer, and shared project footer', () => {
        const html = renderToStaticMarkup(
            <DashboardShell
                surface="public"
                activeRoute="home"
                navigate={vi.fn()}
                unreadCount={0}
            >
                <section data-page-content>공개 홈</section>
            </DashboardShell>,
        );

        expect(html).toContain('data-dashboard-shell="renewal"');
        expect(html).toContain('data-dashboard-surface="public"');
        expect(html).toContain('data-dashboard-route="laundry"');
        expect(html).not.toContain('data-dashboard-route="attendance"');
        expect(html).not.toContain('data-dashboard-route="notifications"');
        expect(html).not.toContain('기기 연결 관리');
        expect(html).toContain('data-slot="sidebar"');
        expect(html).toContain('data-state="expanded"');
        expect(html).toContain('--sidebar-width:14.5rem');
        expect(html).toContain('--sidebar-width-icon:3rem');
        expect(html).toContain('data-shell-top-spacer="true"');
        expect(html).not.toContain('<header');
        expect(html).not.toContain('Jungle Bell은 정글 캠퍼스 생활 정보를 한곳에 모아 보여주는 오픈소스 프로젝트입니다.');
        expect(html).toContain('href="https://github.com/YangSiJun528/jungle-bell"');
        expect(html).toContain('href="https://github.com/YangSiJun528/jungle-bell/discussions/categories/');
        expect(html).toContain('href="https://github.com/YangSiJun528/jungle-bell/releases/latest"');
        expect(html).toContain('href="./blog/index.html"');
        expect(html).toContain('공개 홈');
    });

    test('renders personal utilities separately and keeps the mobile primary navigation to four items', () => {
        const html = renderToStaticMarkup(
            <DashboardShell
                surface="companion"
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
        expect(html).toContain('aria-label="알림 센터, 읽지 않은 알림 120개"');
        expect(html).toContain('aria-label="기기 연결 관리"');
        expect(html).toContain('data-unread="true"');
        expect(html).toContain('text-primary');
        expect(html).not.toContain('99+');
        expect(html).not.toContain('data-slot="badge"');
        expect(html).toContain('aria-current="page"');
        expect(html).toContain('grid-template-columns:repeat(4, minmax(0, 1fr))');
        expect(html).toContain('aria-label="사이드바 접기"');
        expect(html).toContain('data-sidebar="trigger"');
        expect(html).toContain('data-shell-top-spacer="true"');
    });
});
