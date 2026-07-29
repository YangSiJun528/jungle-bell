import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'vitest';

const settings = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const settingsScript = readFileSync(new URL('./settings.ts', import.meta.url), 'utf8');

test('설정 헤더는 앱 정체성과 저장 상태에 집중하고 프로젝트 링크는 앱 탭에 둔다', () => {
    const headerStart = settings.indexOf('<header class="ui-page-header');
    const headerEnd = settings.indexOf('</header>', headerStart);
    const header = settings.slice(headerStart, headerEnd);
    const appSectionStart = settings.indexOf('<section id="app-settings"');
    const appInfoStart = settings.indexOf('data-ui="app-info-settings"', appSectionStart);
    const appInfoEnd = settings.indexOf('</fieldset>', appInfoStart);
    const appInfo = settings.slice(appInfoStart, appInfoEnd);

    assert.match(header, /ui-page-header/);
    assert.match(header, /<img[^>]*class="[^"]*size-12/);
    assert.match(header, /<h1 class="ui-page-title">설정<\/h1>/);
    assert.match(header, /class="ui-page-subtitle"/);
    assert.match(header, /Jungle Bell/);
    assert.match(header, /x-text="appVersion \? `v\$\{appVersion\}` : ''"/);
    assert.match(header, /role="status"[^>]*aria-live="polite"/);
    assert.doesNotMatch(header, /href=/);
    assert.match(appInfo, /<legend[^>]*>앱 정보<\/legend>/);
    assert.match(appInfo, /href="https:\/\/github\.com\/YangSiJun528\/jungle-bell\/releases"[^>]*>릴리즈<\/a>/);
    assert.match(appInfo, /href="https:\/\/github\.com\/YangSiJun528\/jungle-bell"[^>]*>GitHub<\/a>/);
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
    assert.match(navigation, /class="ui-tabs"/);
    assert.equal(navigation.match(/class="ui-tab"/g)?.length, 3);
    assert.equal(navigation.match(/role="tab"/g)?.length, 3);
    assert.match(navigation, />출석<\/button>/);
    assert.match(navigation, />알림<\/button>/);
    assert.match(navigation, />앱<\/button>/);
    assert.match(navigation, /:aria-selected=/);
    assert.match(navigation, /:tabindex=/);
    assert.equal(navigation.match(/@keydown\.arrow-left\.prevent=/g)?.length, 3);
    assert.equal(navigation.match(/@keydown\.arrow-right\.prevent=/g)?.length, 3);
    assert.equal(navigation.match(/\$nextTick\(\(\) => \$refs\.(?:attendanceTab|notificationTab|appTab)\.focus\(\)\)/g)?.length, 6);
    assert.doesNotMatch(navigation, /\bgrid-cols-2\b|\bbg-app-control\b|aria-current/);
});

test('설정 탭을 바꾸면 이전 탭의 스크롤 위치를 이어받지 않는다', () => {
    const selectTabStart = settingsScript.indexOf('async selectTab(tab)');
    const refreshSettingsStart = settingsScript.indexOf('async refreshSettings()', selectTabStart);
    const selectTab = settingsScript.slice(selectTabStart, refreshSettingsStart);

    assert.ok(selectTabStart >= 0);
    assert.match(selectTab, /this\.activeTab = tab;/);
    assert.match(selectTab, /window\.scrollTo\(0,\s*0\);/);
});

test('초기 설정 연결 실패는 기본값 편집 대신 명확한 오류와 재시도를 제공한다', () => {
    const errorStart = settings.indexOf('data-ui="settings-load-error"');
    const errorEnd = settings.indexOf('</section>', errorStart);
    const error = settings.slice(errorStart, errorEnd);
    const initStart = settingsScript.indexOf('async init()');
    const destroyStart = settingsScript.indexOf('destroy()', initStart);
    const init = settingsScript.slice(initStart, destroyStart);

    assert.ok(errorStart >= 0);
    assert.match(error, /role="alert"/);
    assert.match(error, /설정을 불러오지 못했어요/);
    assert.match(error, /@click="retrySettings\(\)"/);
    assert.match(error, />다시 시도<\/button>/);
    assert.match(settings, /x-show="settingsLoading"/);
    assert.match(settings, /x-show="!settingsLoading && settingsLoadError"/);
    assert.match(settingsScript, /connectRequiredSettingsSnapshots/);
    assert.match(settingsScript, /settingsLoading:\s*true/);
    assert.match(settingsScript, /settingsLoadError:\s*''/);
    assert.match(settingsScript, /async retrySettings\(\)/);
    assert.doesNotMatch(init, /finally\s*\{[\s\S]*this\.settingsReady = true/);
    assert.match(settings, /x-show="settingsReady && activeTab === 'attendance'"/);
    assert.match(settings, /x-show="settingsReady && activeTab === 'notification'"/);
    assert.match(settings, /x-show="settingsReady && activeTab === 'app'"/);
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
    assert.match(systemSettings, /<small[^>]*>앱 알림은 알림함에 저장하고 OS 알림으로도 보내요\. 운영체제에서 Jungle Bell 알림을 허용해 주세요\.<\/small>/);
    assert.match(systemSettings, /@click="openNotificationSettings\(\)"[^>]*>열기<\/button>/);
    assert.doesNotMatch(systemSettings, /x-show=/);
    assert.equal(settings.match(/@click="openNotificationSettings\(\)"/g)?.length, 1);
    assert.doesNotMatch(navigation, /openNotificationSettings/);
    assert.doesNotMatch(settings, /class="notification-actions/);
});

test('알림 전달 방식은 사용자 선택 없이 앱 알림함과 OS 알림으로 고정한다', () => {
    const notificationSectionStart = settings.indexOf('<section id="notification-settings"');
    const appSectionStart = settings.indexOf('<section id="app-settings"');
    const notificationSection = settings.slice(notificationSectionStart, appSectionStart);

    assert.doesNotMatch(notificationSection, /data-ui="notification-delivery-settings"/);
    assert.doesNotMatch(notificationSection, /알림 표시 방식/);
    assert.doesNotMatch(notificationSection, /x-model="notificationDelivery"/);
    assert.doesNotMatch(settingsScript, /notificationDelivery/);
    assert.doesNotMatch(settingsScript, /saveNotificationDelivery/);
    assert.doesNotMatch(settingsScript, /set_notification_delivery/);
});

test('새 식단 알림은 식단 화면이 아니라 설정 알림 탭에서 관리한다', () => {
    const notificationSectionStart = settings.indexOf('<section id="notification-settings"');
    const appSectionStart = settings.indexOf('<section id="app-settings"');
    const notificationSection = settings.slice(notificationSectionStart, appSectionStart);
    const mealSettingsStart = notificationSection.indexOf('data-ui="meal-notification-settings"');
    const mealSettingsEnd = notificationSection.indexOf('</fieldset>', mealSettingsStart);
    const mealSettings = notificationSection.slice(mealSettingsStart, mealSettingsEnd);

    assert.ok(mealSettingsStart >= 0);
    assert.match(mealSettings, /<legend[^>]*>생활 알림<\/legend>/);
    assert.match(mealSettings, /<strong[^>]*>새 식단 알림<\/strong>/);
    assert.match(
        mealSettings,
        /<small[^>]*>중식·석식이 게시되면 알림함과 OS 알림으로 알려드려요\.<\/small>/,
    );
    assert.match(mealSettings, /aria-label="새 식단 알림"/);
    assert.match(mealSettings, /x-model="mealSubscription"/);
    assert.match(
        mealSettings,
        /saveToggle\('set_meal_subscription_enabled', 'mealSubscription'\)/,
    );
    assert.match(settingsScript, /target\.mealSubscription = snapshot\.mealSubscription/);
    assert.match(settingsScript, /mealSubscription:\s*true/);
    assert.match(settingsScript, /\|\s*'mealSubscription'/);
});

test('앱 탭은 일반, 권한 및 개인정보, 도움말, 앱 정보, 고급 설정으로 통합한다', () => {
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
    assert.match(appSection, /data-ui="app-info-settings"[^>]*>[\s\S]*?<legend[^>]*>앱 정보<\/legend>/);
    assert.match(appSection, /<summary[^>]*>[\s\S]*?<span[^>]*>고급 설정<\/span>/);
    assert.doesNotMatch(appSection, /<legend[^>]*>(?:앱 실행 및 업데이트|화면|개인정보|시스템 알림|온보딩)<\/legend>/);
    assert.doesNotMatch(appSection, />확인<\/button>/);
    assert.equal(settings.match(/command\('check_and_notify_update'\)/g)?.length, 1);
});

test('자동 업데이트를 끄기 전에는 호환성 경고를 확인한다', () => {
    assert.match(
        settings,
        /aria-label="자동 업데이트"[^>]*x-model="autoUpdate"[^>]*@change="toggleAutoUpdate\(\)"/,
    );
    assert.match(settingsScript, /async toggleAutoUpdate\(\)/);
    assert.match(settingsScript, /requiresAutoUpdateDisableConfirmation\(value\)/);
    assert.match(settingsScript, /AUTO_UPDATE_DISABLE_CONFIRMATION\.message/);
    assert.match(settingsScript, /this\.autoUpdate = true/);
    assert.match(
        settingsScript,
        /invokeSettingsMutation\(this,\s*projectSettings,\s*'set_auto_update',\s*\{enabled: value\}\)/,
    );
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

    assert.match(attendance, /<strong[^>]*>오늘 출석 알림<\/strong>\s*<small/);
    assert.match(attendance, /id="attendance-notification-hint"/);
    assert.doesNotMatch(attendance, /\brounded-lg\b|\bborder-app-divider\b|\bbg-app-surface-subtle\b|\bp-2\b|\bleading-6\b/);
    assert.ok(descriptions.length > 0);
    for (const [description] of descriptions) {
        assert.match(description, /\bui-settings-description\b/);
    }
});

test('종료 출석 설정은 마감 5분 전 긴급 알림을 안내한다', () => {
    const endSectionStart = settings.indexOf('aria-labelledby="end-notification-title"');
    const endSectionEnd = settings.indexOf('</section>', endSectionStart);
    const endSection = settings.slice(endSectionStart, endSectionEnd);

    assert.match(
        endSection,
        /종료 출석을 하지 않으면 마감 5분 전에 긴급 알림을 한 번 더 보내요\./,
    );
    assert.match(endSection, /data-ui="settings-description"/);
    assert.match(endSection, /x-show="endNotification"/);
});

test('출석 알림은 앱의 고정 주기로 반복하고 사용자 간격 설정을 노출하지 않는다', () => {
    const attendanceSectionStart = settings.indexOf('<section id="attendance-settings"');
    const notificationSectionStart = settings.indexOf('<section id="notification-settings"');
    const attendanceSection = settings.slice(attendanceSectionStart, notificationSectionStart);

    assert.doesNotMatch(attendanceSection, /반복 간격|startInterval|endInterval|saveStartInterval|saveEndInterval/);
    assert.doesNotMatch(
        settingsScript,
        /startInterval|endInterval|saveStartInterval|saveEndInterval|set_start_notification_interval|set_end_notification_interval/,
    );
});

test('복수 기수가 조회되면 출석 탭에서 출석 확인 기수를 선택한다', () => {
    const attendanceSectionStart = settings.indexOf('<section id="attendance-settings"');
    const notificationSectionStart = settings.indexOf('<section id="notification-settings"');
    const attendanceSection = settings.slice(attendanceSectionStart, notificationSectionStart);

    assert.match(attendanceSection, /data-ui="cohort-selection"/);
    assert.match(attendanceSection, /출석 확인 기수/);
    assert.match(attendanceSection, /cohortOptions\.length > 1/);
    assert.match(attendanceSection, /자동 선택/);
    assert.match(attendanceSection, /saveSelectedCohort\(\)/);
});

test('일요일 출석 알림은 긍정형 스위치로 표현하고 저장할 때 기존 skip 값을 반전한다', () => {
    assert.match(settings, /<strong[^>]*>일요일 출석 알림<\/strong>/);
    assert.match(settings, /aria-label="일요일 출석 알림"/);
    assert.match(settings, /:checked="sundayNotificationEnabled"/);
    assert.match(settings, /setSundayNotification\(\$event\.currentTarget\.checked\)/);
    assert.match(settingsScript, /get sundayNotificationEnabled\(\)/);
    assert.match(settingsScript, /this\.skipSunday = !enabled/);
    assert.match(settingsScript, /'set_skip_sunday'/);
    assert.doesNotMatch(settings, /일요일에는 알림 보내지 않기/);
});

test('저장된 기수 선택은 동적 option 생성 후에도 select에 명시적으로 반영한다', () => {
    const cohortSelectionStart = settings.indexOf('data-ui="cohort-selection"');
    const cohortSelectionEnd = settings.indexOf('</fieldset>', cohortSelectionStart);
    const cohortSelection = settings.slice(cohortSelectionStart, cohortSelectionEnd);
    const optionsProjection = settingsScript.indexOf('target.cohortOptions = snapshot.cohortOptions');
    const selectionProjection = settingsScript.indexOf('target.selectedCohortId = snapshot.selectedCohortId');

    assert.match(cohortSelection, /:selected="selectedCohortId === ''"/);
    assert.match(cohortSelection, /:selected="selectedCohortId === cohort\.id"/);
    assert.ok(optionsProjection >= 0);
    assert.ok(selectionProjection > optionsProjection);
});
