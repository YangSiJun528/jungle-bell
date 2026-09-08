import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';

import {test} from 'vitest';

const srcRoot = new URL('../../', import.meta.url);
const source = (path: string) => readFileSync(new URL(path, srcRoot), 'utf8');
const dashboard = source('../index.html');
const app = source('./app/dashboard-app.tsx');
const shell = source('./app/shell/DashboardShell.tsx');
const footer = source('./app/shell/DashboardFooter.tsx');
const globals = source('./app/styles/globals.css');
const mobileHook = source('./hooks/use-mobile.ts');
const sidebar = source('./components/ui/sidebar.tsx');
const sheet = source('./components/ui/sheet.tsx');
const alertDialog = source('./components/ui/alert-dialog.tsx');
const routes = source('./app/routes.ts');

test('HTML 문서는 레이아웃을 복제하지 않고 React 셸을 위한 단일 mount만 제공한다', () => {
    assert.equal((dashboard.match(/id="root"/g) ?? []).length, 1);
    assert.equal((dashboard.match(/<script\b/g) ?? []).length, 1);
    assert.match(dashboard, /src="\/src\/main\.ts"/);
    assert.doesNotMatch(dashboard, /<aside|<header|<nav|<main/);
    assert.doesNotMatch(dashboard, /(?:styles|ui|dashboard)\.css/);
});

test('모든 기능 경로는 하나의 DashboardShell과 main 콘텐츠 영역을 재사용한다', () => {
    assert.equal((app.match(/<DashboardShell\b/g) ?? []).length, 1);
    assert.equal((app.match(/<Outlet\b/g) ?? []).length, 1);
    assert.match(
        app,
        /<DashboardShell[\s\S]*notificationPanel=\{\{[\s\S]*<NotificationPanelContent[\s\S]*seenMobileIds=\{seenMobileIds\}[\s\S]*onMobileNotificationsSeen=\{markMobileNotificationsSeen\}[\s\S]*\s\/>[\s\S]*<DashboardRouteRuntimeProvider[\s\S]*<Outlet\s*\/>[\s\S]*<\/DashboardShell>/,
    );

    assert.equal((shell.match(/<Sidebar\b/g) ?? []).length, 1);
    assert.equal((shell.match(/<header\b/g) ?? []).length, 0);
    assert.equal((shell.match(/<SidebarInset\b/g) ?? []).length, 1);
    assert.equal((shell.match(/id="dashboard-content"/g) ?? []).length, 1);
});

test('사이드바는 1024px부터 shadcn 접기·데스크톱 Rail 크기 조절을 사용한다', () => {
    assert.match(shell, /<SidebarProvider[\s\S]{0,160}\bresizable/);
    assert.match(shell, /<Sidebar[\s\S]{0,120}collapsible="icon"/);
    assert.match(shell, /<SidebarTrigger[\s\S]{0,100}aria-label="사이드바 메뉴 열기"/);
    assert.match(shell, /<SidebarCollapseControl\s*\/>/);
    assert.match(shell, /<SidebarRail\b/);
    assert.doesNotMatch(
        shell,
        /type="range"|aria-label="사이드바 너비"|localStorage|sidebarWidth=/,
    );
    assert.equal(existsSync(new URL('./app/sidebar-width.ts', srcRoot)), false);
    assert.equal(existsSync(new URL('./app/sidebar-width.test.ts', srcRoot)), false);
    assert.doesNotMatch(shell, /<header\b/);
    assert.match(shell, /data-shell-top-spacer="true"/);
    assert.match(shell, /min-h-\[calc\(3\.5rem\+var\(--safe-area-top\)\)\]/);
    assert.match(shell, /sm:min-h-\[calc\(4rem\+var\(--safe-area-top\)\)\]/);
    assert.match(shell, /max-w-6xl/);
    assert.match(mobileHook, /DESKTOP_SHELL_BREAKPOINT\s*=\s*1024/);
    assert.doesNotMatch(sidebar, /\bmd:(?:block|flex)/);
    assert.match(sidebar, /\blg:block/);
    assert.match(sidebar, /\blg:flex/);
});

test('320~1023px 셸은 네 방향 safe-area와 하단 내비게이션 여유 공간을 사용한다', () => {
    assert.match(shell, /fixed inset-x-0 bottom-0 z-40/);
    assert.match(shell, /lg:hidden/);
    assert.match(
        shell,
        /style=\{\{gridTemplateColumns: `repeat\(\$\{routes\.length\}, minmax\(0, 1fr\)\)`\}\}/,
    );
    assert.match(shell, /max-w-lg/);
    assert.match(shell, /data-mobile-navigation="true"/);
    assert.match(shell, /data-shell-content="true"/);

    for (const side of ['top', 'right', 'bottom', 'left']) {
        assert.match(
            globals,
            new RegExp(`safe-area-inset-${side}`),
            `${side} safe-area 환경 변수 계약이 없습니다.`,
        );
        assert.match(
            `${shell}\n${footer}`,
            new RegExp(`var\\(--safe-area-${side}\\)`),
            `${side} safe-area가 셸에 적용되지 않았습니다.`,
        );
    }

    assert.match(footer, /--dashboard-mobile-navigation-height/);
    assert.match(footer, /lg:pb-8/);
    assert.match(globals, /min-height:\s*100dvh/);
    assert.match(globals, /min-width:\s*min\(320px, 100%\)/);
    assert.match(globals, /scroll-padding-bottom:/);
    assert.match(globals, /overflow-x:\s*clip/);
});

test('공통 푸터는 외부 링크와 모바일 하단 메뉴 여백만 제공한다', () => {
    assert.match(shell, /<DashboardFooter\s*\/>/);
    assert.match(footer, /<footer\b/);
    assert.match(footer, /max-w-6xl/);
    assert.doesNotMatch(footer, /Jungle Bell은 정글 캠퍼스/);
    assert.match(footer, /github\.com\/YangSiJun528\/jungle-bell/);
    assert.match(footer, /\/issues\/new\/choose/);
    assert.doesNotMatch(footer, /\/discussions(?:\/|\b)/);
    assert.match(footer, /피드백 남기기/);
    assert.match(footer, /릴리즈/);
    assert.match(footer, /lg:pb-8/);
});

test('지원 viewport 계약은 clipping 없이 760px에서 768px로 본문 폭이 역전되지 않는다', () => {
    const viewportWidths = [320, 390, 760, 768, 1023, 1024, 1440] as const;
    const pageGutter = (width: number) => (width >= 768 ? 24 : width >= 640 ? 20 : 16);
    const sidebarWidth = (width: number) => (width >= 1024 ? 256 : 0);
    const contentWidth = (width: number) => width - sidebarWidth(width) - pageGutter(width) * 2;

    for (const width of viewportWidths) {
        assert.ok(contentWidth(width) > 0, `${width}px에서 본문 폭이 사라집니다.`);
        assert.ok(contentWidth(width) <= width, `${width}px에서 페이지 가로 overflow가 납니다.`);
    }

    assert.ok(contentWidth(768) >= contentWidth(760));
    assert.match(globals, /--dashboard-inline-gutter:\s*1rem/);
    assert.match(globals, /min-width:\s*40rem[\s\S]*--dashboard-inline-gutter:\s*1\.25rem/);
    assert.match(globals, /min-width:\s*48rem[\s\S]*--dashboard-inline-gutter:\s*1\.5rem/);
});

test('200% 확대·landscape·키보드 축소에서도 overlay와 CTA는 동적 viewport 안에서 스크롤된다', () => {
    assert.match(globals, /min-height:\s*100svh[\s\S]*min-height:\s*100dvh/);
    assert.match(globals, /scroll-padding-bottom:/);
    assert.match(globals, /scroll-margin-block:/);
    assert.match(sheet, /max-h-dvh[\s\S]*overflow-y-auto[\s\S]*overscroll-contain/);
    assert.match(sheet, /h-dvh/);
    assert.match(
        alertDialog,
        /max-h-\[calc\(100dvh-2rem-var\(--safe-area-top\)-var\(--safe-area-bottom\)\)\]/,
    );
    assert.match(alertDialog, /overflow-y-auto/);
});

test('하단 내비게이션 현재 위치는 aria-current와 비색상 indicator를 함께 제공한다', () => {
    assert.match(shell, /aria-current=\{active \? 'page' : undefined\}/);
    assert.match(shell, /data-active-indicator="true"/);
    assert.match(shell, /aria-hidden="true"/);
});

test('브라우저와 데스크톱은 4개 주요 메뉴와 보조 기능을 공유한다', () => {
    assert.match(
        routes,
        /NAVIGATION_ROUTES\s*=\s*\[[\s\S]*'home'[\s\S]*'attendance'[\s\S]*'laundry'[\s\S]*'meals'[\s\S]*\]/,
    );
    assert.match(
        routes,
        /PERSONAL_UTILITY_ROUTES\s*=\s*\[[\s\S]*'notifications'[\s\S]*'connections'[\s\S]*\]/,
    );
    assert.match(routes, /home:\s*\{label:\s*'홈',\s*shortLabel:\s*'홈'\}/);
    assert.match(routes, /meals:\s*\{label:\s*'식단',\s*shortLabel:\s*'식단'\}/);
    assert.match(shell, /aria-label="개인 도구"/);
    assert.match(shell, /<SidebarFooter className="border-t border-sidebar-border">/);
    assert.match(shell, /aria-label=\{notificationAriaLabel/);
    assert.match(shell, /aria-label="설정"/);
    assert.match(shell, /aria-haspopup="dialog"/);
    assert.match(shell, /overlayClassName="backdrop-blur-sm"/);
    assert.match(shell, /lg:hidden/);
    assert.match(shell, /<Link to=\{dashboardRoutePath\('connections'\)\}>/);
});

test('각 기능 화면은 공통 PageHeader를 사용하고 페이지 내부 레이아웃만 소유한다', () => {
    const featurePages = [
        './features/home/home-page.tsx',
        './features/attendance/attendance-page.tsx',
        './features/laundry/pages/laundry-page.tsx',
        './features/meals/pages/meals-page.tsx',
        './features/connections/connections-page.tsx',
        './features/app-install/app-install-page.tsx',
    ];
    for (const page of featurePages) {
        const pageSource = source(page);
        assert.match(
            pageSource,
            /import \{PageHeader\} from ['"]@\/components\/dashboard\/page-header['"]/,
            `${page}가 공통 PageHeader를 사용하지 않습니다.`,
        );
        assert.match(pageSource, /<PageHeader\b/, `${page}에 PageHeader 렌더링이 없습니다.`);
        assert.doesNotMatch(
            pageSource,
            /<DashboardShell\b/,
            `${page}가 앱 셸을 중복 렌더링합니다.`,
        );
    }

    const notificationPanel = source('./features/notifications/notifications-page.tsx');
    assert.match(notificationPanel, /export function NotificationPanelContent/);
    assert.match(notificationPanel, /id="notification-inbox-title">\s*받은 알림\s*<\/h2>/);
    assert.doesNotMatch(notificationPanel, /<PageHeader\b|<DashboardShell\b/);
});
