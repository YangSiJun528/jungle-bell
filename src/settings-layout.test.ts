import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'vitest';

const settings = readFileSync(new URL('./index.html', import.meta.url), 'utf8');

test('앱 정보와 프로젝트 링크를 기존 높이의 설정 헤더에 배치한다', () => {
    const headerStart = settings.indexOf('<header class="mb-4');
    const headerEnd = settings.indexOf('</header>', headerStart);
    const header = settings.slice(headerStart, headerEnd);

    assert.match(header, /min-h-12/);
    assert.match(header, /<img[^>]*class="[^"]*size-12/);
    assert.match(header, />설정<\/h1>/);
    assert.match(header, /Jungle Bell/);
    assert.match(header, /x-text="appVersion \? `v\$\{appVersion\}` : ''"/);
    assert.match(header, /aria-label="앱 정보"/);
    assert.match(header, /href="https:\/\/github\.com\/YangSiJun528\/jungle-bell\/releases"[^>]*>릴리즈<\/a>/);
    assert.match(header, /href="https:\/\/github\.com\/YangSiJun528\/jungle-bell"[^>]*>GitHub<\/a>/);
    assert.doesNotMatch(settings, /app-info-title|<h2[^>]*>앱 정보<\/h2>/);
});

test('온보딩 다시 보기는 앱 탭의 도움말 항목으로 제공한다', () => {
    const topNavigationLabel = settings.indexOf('aria-label="설정 분류"');
    const topNavigationStart = settings.lastIndexOf('<nav', topNavigationLabel);
    const topNavigationEnd = settings.indexOf('</nav>', topNavigationStart);
    const topNavigation = settings.slice(topNavigationStart, topNavigationEnd);
    const appSectionStart = settings.indexOf('<section id="app-settings"');
    const helpStart = settings.indexOf('data-ui="help-settings"', appSectionStart);
    const helpEnd = settings.indexOf('</fieldset>', helpStart);
    const help = settings.slice(helpStart, helpEnd);

    assert.ok(topNavigationStart >= 0);
    assert.doesNotMatch(topNavigation, /command\('open_onboarding'\)|온보딩 다시 보기/);
    assert.ok(appSectionStart >= 0);
    assert.ok(helpStart > appSectionStart);
    assert.match(help, /<legend[^>]*>도움말<\/legend>/);
    assert.match(help, /data-ui="onboarding-settings"/);
    assert.match(help, /command\('open_onboarding'\)/);
    assert.match(help, />다시 보기<\/button>/);
    assert.equal(settings.match(/command\('open_onboarding'\)/g)?.length, 1);
    assert.doesNotMatch(settings, /aria-label="설정 도움말"/);
});

test('설정 분류는 메인 화면과 같은 밑줄형 탭으로 표시한다', () => {
    const navigationLabel = settings.indexOf('aria-label="설정 분류"');
    const navigationStart = settings.lastIndexOf('<nav', navigationLabel);
    const navigationEnd = settings.indexOf('</nav>', navigationStart);
    const navigation = settings.slice(navigationStart, navigationEnd);

    assert.match(navigation, /role="tablist"/);
    assert.match(navigation, /\bflex\b/);
    assert.match(navigation, /\bborder-b\b/);
    assert.match(navigation, /role="tab"/);
    assert.match(navigation, /:aria-selected=/);
    assert.match(navigation, /after:bg-app-accent/);
    assert.doesNotMatch(navigation, /\bgrid-cols-2\b|\bbg-app-control\b|aria-current/);
});

test('시스템 알림 설정은 알림 탭의 설명이 있는 독립 항목으로 제공한다', () => {
    const navigationLabel = settings.indexOf('aria-label="설정 분류"');
    const navigationStart = settings.lastIndexOf('<nav', navigationLabel);
    const navigationEnd = settings.indexOf('</nav>', navigationStart);
    const navigation = settings.slice(navigationStart, navigationEnd);
    const notificationSectionStart = settings.indexOf('<section id="notification-settings"');
    const appSectionStart = settings.indexOf('<section id="app-settings"');
    const systemSettingsStart = settings.indexOf('data-ui="system-notification-settings"', notificationSectionStart);
    const systemSettingsEnd = settings.indexOf('</fieldset>', systemSettingsStart);
    const systemSettings = settings.slice(systemSettingsStart, systemSettingsEnd);

    assert.ok(systemSettingsStart > notificationSectionStart);
    assert.ok(systemSettingsStart < appSectionStart);
    assert.match(systemSettings, /<legend[^>]*>시스템 알림<\/legend>/);
    assert.match(systemSettings, /<strong[^>]*>시스템 알림 설정<\/strong>/);
    assert.match(systemSettings, /<small[^>]*>운영체제 설정에서 Jungle Bell 알림이 허용되어 있어야 출석 알림이 전송됩니다\.<\/small>/);
    assert.match(systemSettings, /@click="openNotificationSettings\(\)"[^>]*>열기<\/button>/);
    assert.equal(settings.match(/@click="openNotificationSettings\(\)"/g)?.length, 1);
    assert.doesNotMatch(navigation, /openNotificationSettings/);
    assert.doesNotMatch(settings, /class="notification-actions/);
});

test('앱 탭은 일반, 권한 및 개인정보, 도움말, 고급 설정으로 통합한다', () => {
    const appSectionStart = settings.indexOf('<section id="app-settings"');
    const appSectionEnd = settings.indexOf('</main>', appSectionStart);
    const appSection = settings.slice(appSectionStart, appSectionEnd);
    const generalStart = appSection.indexOf('data-ui="general-settings"');
    const generalEnd = appSection.indexOf('</fieldset>', generalStart);
    const general = appSection.slice(generalStart, generalEnd);

    assert.match(general, /<legend[^>]*>일반<\/legend>/);
    assert.match(general, /자동 시작/);
    assert.match(general, /자동 업데이트/);
    assert.match(general, /앱 아이콘 표시/);
    assert.match(general, /D-Day 표시/);
    assert.match(general, /border-t border-app-divider/);
    assert.match(appSection, /data-ui="privacy-settings"[^>]*>[\s\S]*?<legend[^>]*>권한 및 개인정보<\/legend>/);
    assert.match(appSection, /data-ui="help-settings"[^>]*>[\s\S]*?<legend[^>]*>도움말<\/legend>/);
    assert.match(appSection, /<summary[^>]*>[\s\S]*?<span>고급 설정<\/span>/);
    assert.doesNotMatch(appSection, /<legend[^>]*>(?:앱 실행 및 업데이트|화면|개인정보|시스템 알림|온보딩)<\/legend>/);
    assert.doesNotMatch(appSection, />확인<\/button>/);
    assert.equal(settings.match(/command\('check_and_notify_update'\)/g)?.length, 1);
});

test('설정 행이 아닌 우측 스위치를 직접 눌렀을 때만 토글한다', () => {
    const checkboxCount = settings.match(/type="checkbox"/g)?.length ?? 0;
    const toggleTargetCount = settings.match(/<label[^>]*data-ui="settings-toggle"/g)?.length ?? 0;
    const namedCheckboxCount = settings.match(/<input[^>]*type="checkbox"[^>]*aria-label="[^"]+"/g)?.length ?? 0;

    assert.ok(checkboxCount > 0);
    assert.equal(toggleTargetCount, checkboxCount);
    assert.equal(namedCheckboxCount, checkboxCount);
    assert.doesNotMatch(settings, /<label[^>]*class="[^"]*\bw-full\b/);
});

test('이번 출석 알림 안내와 모든 추가 설명은 별도 박스 없이 같은 작은 글씨 스타일을 사용한다', () => {
    const attendanceStart = settings.indexOf('<fieldset class="attendance-notification');
    const attendanceEnd = settings.indexOf('</fieldset>', attendanceStart);
    const attendance = settings.slice(attendanceStart, attendanceEnd);
    const descriptions = [...settings.matchAll(/<small[^>]*data-ui="settings-description"[^>]*>/g)];

    assert.match(attendance, /<strong[^>]*>이번 출석 알림<\/strong>\s*<small/);
    assert.match(attendance, /id="attendance-notification-hint"/);
    assert.doesNotMatch(attendance, /\brounded-lg\b|\bborder-app-divider\b|\bbg-app-surface-subtle\b|\bp-2\b|\bleading-6\b/);
    assert.ok(descriptions.length > 0);
    for (const [description] of descriptions) {
        assert.match(description, /\bmt-1\b/);
        assert.match(description, /\bblock\b/);
        assert.match(description, /\btext-xs\b/);
        assert.match(description, /\bleading-\[1\.45\]/);
        assert.match(description, /\btext-app-muted\b/);
    }
});
