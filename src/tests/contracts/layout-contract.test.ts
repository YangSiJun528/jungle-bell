import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'vitest';

const srcRoot = new URL('../../', import.meta.url);
const source = (path: string) => readFileSync(new URL(path, srcRoot), 'utf8');
const dashboard = source('./dashboard.html');
const app = source('./app/dashboard-app.tsx');
const shell = source('./app/shell/DashboardShell.tsx');
const routes = source('./app/routes.ts');

test('HTML 문서는 레이아웃을 복제하지 않고 React 셸을 위한 단일 mount만 제공한다', () => {
    assert.equal((dashboard.match(/id="root"/g) ?? []).length, 1);
    assert.equal((dashboard.match(/<script\b/g) ?? []).length, 1);
    assert.match(dashboard, /src="\/app\/main\.tsx"/);
    assert.doesNotMatch(dashboard, /<aside|<header|<nav|<main/);
    assert.doesNotMatch(dashboard, /(?:styles|ui|dashboard)\.css/);
});

test('모든 기능 경로는 하나의 DashboardShell과 main 콘텐츠 영역을 재사용한다', () => {
    assert.equal((app.match(/<DashboardShell\b/g) ?? []).length, 1);
    assert.equal((app.match(/<RouteContent\b/g) ?? []).length, 1);
    assert.match(app, /<DashboardShell[\s\S]*notificationPanel=\{\{[\s\S]*<NotificationPanelContent[\s\S]*seenMobileIds=\{seenMobileIds\}[\s\S]*onMobileNotificationSeen=\{markMobileNotificationSeen\}[\s\S]*\/>[\s\S]*<RouteContent[\s\S]*route=\{contentRoute\}[\s\S]*onRequestInstall=\{openInstallPrompt\}[\s\S]*\/>[\s\S]*<\/DashboardShell>/);

    assert.equal((shell.match(/<Sidebar\b/g) ?? []).length, 1);
    assert.equal((shell.match(/<header\b/g) ?? []).length, 0);
    assert.equal((shell.match(/<SidebarInset\b/g) ?? []).length, 1);
    assert.equal((shell.match(/id="dashboard-content"/g) ?? []).length, 1);
});

test('데스크톱 사이드바는 저장 가능한 폭 조절과 글로벌 헤더 없는 레이아웃을 제공한다', () => {
    assert.match(shell, /<SidebarProvider[\s\S]{0,180}sidebarWidth=\{`\$\{sidebarWidth\}px`\}[\s\S]{0,180}keyboardShortcut=\{null\}/);
    assert.match(shell, /<Sidebar[\s\S]{0,120}collapsible="none"/);
    assert.match(shell, /type="range"/);
    assert.match(shell, /aria-label="사이드바 너비"/);
    assert.match(shell, /min=\{MIN_SIDEBAR_WIDTH\}[\s\S]*max=\{MAX_SIDEBAR_WIDTH\}[\s\S]*step=\{SIDEBAR_WIDTH_STEP\}/);
    assert.match(shell, /writeSidebarWidth\(window\.localStorage, next\)/);
    assert.doesNotMatch(shell, /sidebarWidthIcon=|<SidebarTrigger|<SidebarRail/);
    assert.doesNotMatch(shell, /<header\b/);
    assert.match(shell, /sticky top-0/);
    assert.match(shell, /data-shell-top-spacer="true"/);
    assert.match(shell, /h-14[\s\S]{0,120}sm:h-16/);
    assert.match(shell, /max-w-6xl/);
    assert.match(shell, /md:p-5[\s\S]*lg:p-6/);
});

test('모바일은 safe-area를 반영한 하단 내비게이션과 충분한 본문 여백을 사용한다', () => {
    assert.match(shell, /fixed inset-x-0 bottom-0 z-40/);
    assert.match(shell, /pb-\[calc\(env\(safe-area-inset-bottom\)\+0\.375rem\)\]/);
    assert.match(shell, /md:hidden/);
    assert.match(shell, /style=\{\{gridTemplateColumns: `repeat\(\$\{routes\.length\}, minmax\(0, 1fr\)\)`\}\}/);
    assert.match(shell, /p-3[\s\S]*sm:p-4[\s\S]*md:p-5[\s\S]*lg:p-6/);
    assert.match(shell, /max-w-lg/);
});

test('공통 푸터는 외부 링크와 모바일 하단 메뉴 여백만 제공한다', () => {
    const footer = source('./app/shell/DashboardFooter.tsx');

    assert.match(shell, /<DashboardFooter\s*\/>/);
    assert.match(footer, /<footer\b/);
    assert.match(footer, /max-w-6xl/);
    assert.doesNotMatch(footer, /Jungle Bell은 정글 캠퍼스/);
    assert.match(footer, /github\.com\/YangSiJun528\/jungle-bell/);
    assert.match(footer, /피드백 남기기/);
    assert.match(footer, /릴리즈/);
    assert.match(footer, /\.\/blog\/index\.html/);
    assert.match(footer, /pb-28[\s\S]{0,160}md:pb-8/);
});

test('공개 화면은 3개, 개인 화면은 4개 주요 메뉴를 유지하고 보조 기능을 분리한다', () => {
    assert.match(routes, /PUBLIC_NAVIGATION_ROUTES\s*=\s*\[[\s\S]*'home'[\s\S]*'laundry'[\s\S]*'meals'[\s\S]*\]/);
    assert.match(routes, /PERSONAL_NAVIGATION_ROUTES\s*=\s*\[[\s\S]*'home'[\s\S]*'attendance'[\s\S]*'laundry'[\s\S]*'meals'[\s\S]*\]/);
    assert.match(routes, /PERSONAL_UTILITY_ROUTES\s*=\s*\[[\s\S]*'notifications'[\s\S]*'connections'[\s\S]*\]/);
    assert.match(shell, /aria-label="개인 도구"/);
    assert.match(shell, /className=\{personal \? 'border-t border-sidebar-border' : undefined\}/);
    assert.match(shell, /aria-label=\{notificationAriaLabel/);
    assert.match(shell, /aria-label="설정"/);
    assert.match(shell, /aria-haspopup="dialog"/);
    assert.match(shell, /overlayClassName="backdrop-blur-sm"/);
    assert.match(shell, /md:hidden/);
    assert.match(shell, /onClick=\{\(\) => navigate\('connections'\)\}/);
});

test('각 기능 화면은 공통 PageHeader를 사용하고 페이지 내부 레이아웃만 소유한다', () => {
    const featurePages = [
        './features/home/home-page.tsx',
        './features/attendance/attendance-page.tsx',
        './features/laundry/pages/laundry-page.tsx',
        './features/meals/pages/meals-page.tsx',
        './features/connections/connections-page.tsx',
    ];
    for (const page of featurePages) {
        const pageSource = source(page);
        assert.match(pageSource, /import \{PageHeader\} from ['"]@\/components\/dashboard\/page-header['"]/, `${page}가 공통 PageHeader를 사용하지 않습니다.`);
        assert.match(pageSource, /<PageHeader\b/, `${page}에 PageHeader 렌더링이 없습니다.`);
        assert.doesNotMatch(pageSource, /<DashboardShell\b/, `${page}가 앱 셸을 중복 렌더링합니다.`);
    }

    const notificationPanel = source('./features/notifications/notifications-page.tsx');
    assert.match(notificationPanel, /export function NotificationPanelContent/);
    assert.match(notificationPanel, /id="notification-inbox-title">받은 알림<\/h2>/);
    assert.doesNotMatch(notificationPanel, /<PageHeader\b|<DashboardShell\b/);
});
