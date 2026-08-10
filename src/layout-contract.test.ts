import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'vitest';

const uiStyles = readFileSync(new URL('./ui.css', import.meta.url), 'utf8');
const dashboardStyles = readFileSync(new URL('./dashboard.css', import.meta.url), 'utf8');
const dashboard = readFileSync(new URL('./dashboard.html', import.meta.url), 'utf8');
const ordinaryPages = [
    './dashboard.html',
].map((path) => ({path, source: readFileSync(new URL(path, import.meta.url), 'utf8')}));

test('페이지 외곽 여백은 16px이고 우측 8px 스크롤바를 포함한다', () => {
    assert.match(uiStyles, /--page-gutter:\s*var\(--space-4\)/);
    assert.match(uiStyles, /--scrollbar-size:\s*var\(--space-2\)/);
    assert.match(uiStyles, /scrollbar-gutter:\s*stable both-edges/);
    assert.match(
        uiStyles,
        /body\s*\{[^}]*padding-inline:\s*calc\(var\(--page-gutter\) - var\(--scrollbar-size\)\);/s,
    );
    assert.match(
        uiStyles,
        /\*::\-webkit-scrollbar\s*\{[^}]*width:\s*var\(--scrollbar-size\);/s,
    );
});

test('대시보드는 공통 외곽 여백을 덮어쓰지 않는다', () => {
    const dashboardBody = dashboardStyles.match(/body\[data-ui-page=["']dashboard["']\]\s*\{([^}]*)\}/)?.[1] ?? '';
    assert.doesNotMatch(dashboardBody, /\bpadding\s*:\s*0\s*;/);
    assert.match(dashboardBody, /padding-block:\s*0\s*;/);
    assert.match(dashboardStyles, /\.dashboard-shell\s*\{[^}]*width:\s*min\(1180px,\s*100%\);/s);
    assert.doesNotMatch(dashboardStyles, /\.dashboard-shell\s*\{[^}]*padding-inline:/s);
});

test('redirect 화면을 포함한 일반 페이지는 공통 gutter 스타일을 사용한다', () => {
    for (const {path, source} of ordinaryPages) {
        assert.match(source, /<link\b[^>]*href=["'][^"']*ui\.css["']/, `${path}가 공통 UI CSS를 불러오지 않습니다.`);
        assert.match(source, /<body\b[^>]*data-ui-page=["'][^"']+["']/, `${path}에 페이지 역할이 없습니다.`);
        assert.doesNotMatch(source, /<html\b[^>]*data-page-layout=["']bleed["']/, `${path}가 일반 gutter를 우회합니다.`);
    }
});

test('대시보드의 모든 경로는 하나의 공통 셸 헤더와 푸터를 재사용한다', () => {
    assert.match(uiStyles, /\.ui-app-header\s*\{/);
    assert.match(uiStyles, /\.ui-app-footer\s*\{/);
    assert.equal((dashboard.match(/class="[^"]*\bui-app-header\b[^"]*"/g) ?? []).length, 1);
    assert.equal((dashboard.match(/class="[^"]*\bui-app-footer\b[^"]*"/g) ?? []).length, 1);

    const sharedHeader = dashboard.indexOf('ui-app-header');
    const firstRoute = dashboard.indexOf('data-dashboard-page="attendance"');
    const lastRoute = dashboard.indexOf('data-dashboard-page="connections"');
    const sharedFooter = dashboard.indexOf('ui-app-footer');
    assert.ok(sharedHeader >= 0 && sharedHeader < firstRoute);
    assert.ok(sharedFooter > lastRoute);
});
