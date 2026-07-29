import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'vitest';
import {
    newsItemLabel,
    sortNewsItems,
    splitStatusText,
    statusPresentation,
    type NewsItem,
    type TrayPanelState,
} from './tray-panel-state.ts';

const traySource = readFileSync(new URL('../src-tauri/src/tray.rs', import.meta.url), 'utf8');
const tauriConfig = JSON.parse(
    readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'),
) as {app: {macOSPrivateApi?: boolean}};
const trayCapability = JSON.parse(
    readFileSync(new URL('../src-tauri/capabilities/tray-panel.json', import.meta.url), 'utf8'),
) as {permissions: string[]};

function panelState(overrides: Partial<TrayPanelState> = {}): TrayPanelState {
    return {
        status: 'loading',
        statusText: '상태 확인 중...',
        ddayText: 'D-day 확인 중...',
        ddayPeriod: null,
        currentVersion: '0.4.4',
        pendingUpdate: null,
        ...overrides,
    };
}

test('현재 상태에 따라 강조 톤과 출석 CTA를 결정한다', () => {
    assert.deepEqual(statusPresentation('needsLogin'), {
        tone: 'warning',
        actionLabel: '로그인하기',
    });
    assert.deepEqual(statusPresentation('active'), {
        tone: 'danger',
        actionLabel: '출석 페이지 열기',
    });
    assert.deepEqual(statusPresentation('complete'), {
        tone: 'success',
        actionLabel: null,
    });
});

test('출석 상태의 시간 안내를 작은 보조 문구로 분리한다', () => {
    assert.deepEqual(splitStatusText('학습 종료 가능 (3시간 49분 남음)'), {
        title: '학습 종료 가능',
        detail: '3시간 49분 남음',
    });
    assert.deepEqual(splitStatusText('학습 중 (종료 가능까지 4시간 3분)'), {
        title: '학습 중',
        detail: '종료 가능까지 4시간 3분',
    });
    assert.deepEqual(splitStatusText('오늘 출석 완료'), {
        title: '오늘 출석 완료',
        detail: null,
    });
});

test('Discussion 소식 유형을 표시한다', () => {
    const items: NewsItem[] = [
        {
            id: 'discussion-12',
            type: 'announcement',
            title: '출석 상태 확인 방식 안내',
            body: '변경된 출석 상태 확인 방식을 안내합니다.',
            url: 'https://github.com/YangSiJun528/jungle-bell/discussions/12',
            category: 'Announcements',
            createdAt: '2026-07-24T00:00:00Z',
            updatedAt: '2026-07-24T00:00:00Z',
        },
        {
            id: 'discussion-13',
            type: 'poll',
            title: '다음 기능 설문',
            body: '어떤 기능이 필요한가요?',
            url: 'https://github.com/YangSiJun528/jungle-bell/discussions/13',
            category: 'Polls',
            createdAt: '2026-07-24T01:00:00Z',
            updatedAt: '2026-07-24T01:00:00Z',
        },
    ];

    assert.equal(newsItemLabel(items[0]!), '공지');
    assert.equal(newsItemLabel(items[1]!), '설문');
});

test('상단 고정 공지를 먼저, 각 그룹에서는 작성일 최신순으로 정렬한다', () => {
    const items = [
        {
            id: 'discussion-12',
            type: 'announcement' as const,
            title: '일반 최신 공지',
            body: '내용',
            url: 'https://github.com/YangSiJun528/jungle-bell/discussions/12',
            category: '공지',
            pinned: false,
            createdAt: '2026-07-24T03:00:00Z',
            updatedAt: '2026-07-24T03:00:00Z',
        },
        {
            id: 'discussion-10',
            type: 'announcement' as const,
            title: '고정 이전 공지',
            body: '내용',
            url: 'https://github.com/YangSiJun528/jungle-bell/discussions/10',
            category: '공지',
            pinned: true,
            createdAt: '2026-07-24T01:00:00Z',
            updatedAt: '2026-07-24T01:00:00Z',
        },
        {
            id: 'discussion-11',
            type: 'announcement' as const,
            title: '고정 최신 공지',
            body: '내용',
            url: 'https://github.com/YangSiJun528/jungle-bell/discussions/11',
            category: '공지',
            pinned: true,
            createdAt: '2026-07-24T02:00:00Z',
            updatedAt: '2026-07-24T02:00:00Z',
        },
    ];

    assert.deepEqual(
        sortNewsItems(items).map((item) => item.id),
        ['discussion-11', 'discussion-10', 'discussion-12'],
    );
    assert.equal(newsItemLabel(items[1]!), '상단 고정');
});

test('트레이 패널은 홈과 소식 화면 및 기존 주요 액션을 제공한다', () => {
    const html = readFileSync(new URL('./tray-panel.html', import.meta.url), 'utf8');
    const script = readFileSync(new URL('./tray-panel.ts', import.meta.url), 'utf8');
    const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
    const uiStyles = readFileSync(new URL('./ui.css', import.meta.url), 'utf8');
    const attendanceCardMarker = html.indexOf('data-ui="attendance-status"');
    const attendanceCardStart = html.lastIndexOf('<button', attendanceCardMarker);
    const attendanceCardEnd = html.indexOf('</button>', attendanceCardMarker) + 9;
    const attendanceCard = html.slice(attendanceCardStart, attendanceCardEnd);
    const ddayCardStart = html.indexOf('data-ui="dday"');
    const ddayCardEnd = html.indexOf('</aside>', ddayCardStart) + 8;
    const ddayCard = html.slice(ddayCardStart, ddayCardEnd);
    const laundryActionStart = html.indexOf('@click="perform(\'open_laundry\')"');
    const laundryActionEnd = html.indexOf('</button>', laundryActionStart);
    const laundryAction = html.slice(laundryActionStart, laundryActionEnd);
    const mealsActionStart = html.indexOf('@click="perform(\'open_meals\')"');
    const mealsActionEnd = html.indexOf('</button>', mealsActionStart);
    const mealsAction = html.slice(mealsActionStart, mealsActionEnd);
    const panelHeader = html.slice(html.indexOf('<header'), html.indexOf('</header>') + 9);
    const appMenuStart = panelHeader.indexOf('data-ui="app-menu"');
    const appMenu = panelHeader.slice(appMenuStart);

    assert.match(html, /<body[^>]*data-ui-page="tray-panel"/);
    assert.match(html, /rounded-ui-window/);
    assert.match(html, /<main\s+class="[^"]*\bshadow-none\b[^"]*"/);
    assert.match(html, /<main\s+class="[^"]*\bbg-app-bg\b[^"]*"/);
    assert.doesNotMatch(html, /<main\s+class="[^"]*\bbg-app-overlay\b[^"]*"/);
    assert.match(html, /<img class="size-8[^"]*" src="assets\/logo\.png"/);
    assert.match(html, /<nav class="[^"]*\bui-tabs\b[^"]*" role="tablist"/);
    assert.equal(html.match(/class="ui-tab"/g)?.length, 2);
    assert.match(html, /:aria-selected="activeTab === 'home'"/);
    assert.match(html, /:aria-selected="activeTab === 'news'"/);
    assert.equal(html.match(/@keydown\.arrow-left\.prevent=/g)?.length, 2);
    assert.equal(html.match(/@keydown\.arrow-right\.prevent=/g)?.length, 2);
    assert.equal(html.match(/\$nextTick\(\(\) => \$refs\.(?:homeTab|newsTab)\.focus\(\)\)/g)?.length, 4);
    assert.doesNotMatch(html, /<nav class="[^"]*(?:grid-cols-2|bg-app-control)[^"]*" role="tablist"/);
    assert.match(uiStyles, /\.ui-tab\[aria-selected="true"\]/);
    assert.doesNotMatch(html, /after:absolute after:inset-x-0 after:bottom-0/);
    assert.match(html, />홈</);
    assert.match(html, />\s*소식\s*<\/button>/);
    assert.match(html, />소식</);
    assert.doesNotMatch(html, /newsTotal|aria-label="새 소식"/);
    assert.doesNotMatch(script, /seenNewsIds|SEEN_NEWS_KEY|markNewsSeen|newsCount/);
    assert.match(html, /등록된 소식이 없어요/);
    assert.match(html, /bg-app-info-soft/);
    assert.match(html, /newsItems/);
    assert.match(html, /openNewsItem/);
    assert.doesNotMatch(html, /perform\('open_discussions'\)|궁금해요에 질문하기/);
    assert.doesNotMatch(script, /\|\s*'open_discussions'/);
    assert.doesNotMatch(traySource, /OpenDiscussions|DISCUSSIONS_URL/);
    assert.ok(attendanceCardMarker >= 0);
    assert.ok(attendanceCardStart >= 0);
    assert.match(attendanceCard, /^<button/);
    assert.match(attendanceCard, /perform\('open_attendance'\)/);
    assert.match(attendanceCard, /:aria-label=/);
    assert.match(attendanceCard, /presentation\.actionLabel \?\? '출석 상태 확인'/);
    assert.match(attendanceCard, /x-text="statusTextParts\.title"/);
    assert.match(attendanceCard, /x-show="statusTextParts\.detail"/);
    assert.match(attendanceCard, /text-ui-caption[^"]*text-app-muted/);
    assert.doesNotMatch(attendanceCard, /<strong[^>]*x-text="state\.statusText"/);
    assert.doesNotMatch(attendanceCard, /presentation\.label/);
    assert.match(attendanceCard, /data-icon="chevron-right"/);
    assert.doesNotMatch(attendanceCard, /<footer|x-text="presentation\.actionLabel/);
    assert.doesNotMatch(attendanceCard, /state\.ddayText/);
    assert.ok(ddayCardStart > attendanceCardEnd);
    assert.match(ddayCard, /state\.ddayText/);
    assert.match(ddayCard, /x-show="ddayProgress"/);
    assert.match(ddayCard, /x-show="!ddayProgress"/);
    assert.match(ddayCard, /x-text="ddayRange\(\)"/);
    assert.match(ddayCard, /`완료 \$\{ddayProgress\.elapsed\}일`/);
    assert.match(ddayCard, /`남음 \$\{ddayProgress\.remaining\}일`/);
    assert.match(ddayCard, /`\$\{ddayProgress\.percent\}%`/);
    assert.match(ddayCard, /<progress\s+class="ui-progress[^"]*"/);
    assert.match(ddayCard, /:value="ddayProgress\?\.percent \?\? 0"/);
    assert.match(ddayCard, /aria-label="D-Day 진행률"/);
    assert.match(ddayCard, /:aria-valuetext="ddayProgressLabel\(\)"/);
    assert.doesNotMatch(
        ddayCard,
        /<button|toggleDday|ddayExpanded|aria-expanded|aria-controls|dday-calendar|data-ui-density|grid-cols-\[repeat\(31|x-for="day in 31"|x-for="row in ddayProgress/,
    );
    assert.match(script, /buildDdayProgress/);
    assert.doesNotMatch(script, /ddayExpanded|toggleDday/);
    assert.doesNotMatch(script, /ddayUnit|setDdayUnit/);
    assert.doesNotMatch(html, /quick-action-title/);
    assert.match(html, /워시타워/);
    assert.match(html, /오늘의 식단/);
    assert.doesNotMatch(laundryAction, /data-icon="chevron-right"/);
    assert.doesNotMatch(mealsAction, /data-icon="chevron-right"/);
    assert.match(panelHeader, /aria-label="앱 메뉴"/);
    assert.match(panelHeader, /data-icon="nut"/);
    assert.doesNotMatch(panelHeader, /data-icon="bolt"/);
    assert.doesNotMatch(panelHeader, /aria-label="패널 닫기"/);
    assert.doesNotMatch(panelHeader, /@click="hide\(\)"/);
    assert.match(panelHeader, /@click="toggleMenu\(\)"/);
    assert.match(panelHeader, /x-ref="menuTrigger"/);
    assert.match(appMenu, /role="menu"/);
    assert.match(appMenu, /@keydown="handleMenuKey\(\$event\)"/);
    assert.match(appMenu, /x-transition:enter=/);
    assert.doesNotMatch(appMenu, /x-transition:leave/);
    assert.match(appMenu, /업데이트 확인/);
    assert.match(appMenu, /x-show="state\.pendingUpdate"/);
    assert.match(appMenu, />\(업데이트 필요\)<\/span>/);
    assert.match(appMenu, /perform\('check_update'\)/);
    assert.match(appMenu, />설정</);
    assert.match(appMenu, /perform\('open_settings'\)/);
    assert.match(appMenu, /피드백/);
    assert.match(appMenu, /perform\('open_feedback'\)/);
    assert.match(appMenu, /data-icon="external-link"/);
    assert.match(appMenu, /border-t border-app-divider/);
    assert.match(appMenu, />종료</);
    assert.match(appMenu, /perform\('quit'\)/);
    assert.match(script, /\|\s*'open_feedback'/);
    assert.match(script, /\|\s*'quit'/);
    assert.match(script, /menuOpen:\s*false/);
    assert.match(script, /event\.key === 'ArrowDown'/);
    assert.match(script, /event\.key === 'ArrowUp'/);
    assert.match(script, /event\.key === 'Home'/);
    assert.match(script, /event\.key === 'End'/);
    assert.match(script, /closeMenu\(true\)/);
    assert.match(script, /menuTrigger\?\.focus\(\)/);
    assert.match(script, /window\.addEventListener\('blur',\s*\(\)\s*=>\s*this\.closeMenu\(\)\)/);
    assert.doesNotMatch(html, /<footer class="flex h-12/);
    assert.match(styles, /--jungle-info:/);
    assert.match(uiStyles, /--color-app-info:/);
    assert.doesNotMatch(html, /트레이에서 상태와 새 소식을 한 번에/);
    assert.doesNotMatch(html, /업데이트와 중요한 소식을 모아볼 수 있어요/);
    assert.doesNotMatch(html, /릴리즈 노트 예시/);
    assert.doesNotMatch(html, /LMS에서 시작·종료 체크하기/);
    assert.doesNotMatch(html, /이 패널에 의견 보내기/);
    assert.doesNotMatch(html, /attendanceNotificationVisible/);
});

test('트레이 패널은 macOS에서도 투명한 네이티브 창 위에 렌더링한다', () => {
    assert.equal(tauriConfig.app.macOSPrivateApi, true);
    assert.doesNotMatch(
        traySource,
        /#\[cfg\(not\(target_os = "macos"\)\)\]\s*let builder = builder\.transparent\(true\);/,
    );
    assert.match(traySource, /\.shadow\(false\)\s*\.transparent\(true\)/);
    assert.match(traySource, /\.transparent\(true\)/);
});

test('피드백 메뉴는 허용된 GitHub 이슈 선택 화면만 연다', () => {
    assert.match(
        traySource,
        /const FEEDBACK_URL: &str =\s*"https:\/\/github\.com\/YangSiJun528\/jungle-bell\/issues\/new\/choose";/,
    );
    assert.match(traySource, /OpenFeedback/);
    assert.match(traySource, /TrayPanelAction::OpenFeedback =>/);
});

test('홈은 진행 중인 세탁을 D-Day보다 먼저 보여주고 생활 알림에는 급식 게시 이벤트만 표시한다', () => {
    const html = readFileSync(new URL('./tray-panel.html', import.meta.url), 'utf8');
    const script = readFileSync(new URL('./tray-panel.ts', import.meta.url), 'utf8');
    const ddayStart = html.indexOf('data-ui="dday"');
    const ddayEnd = html.indexOf('</aside>', ddayStart) + 8;
    const activityStart = html.indexOf('data-ui="laundry-activity"');
    const alertsStart = html.indexOf('data-ui="home-tasks"');

    assert.match(html, /data-ui="laundry-activity"/);
    assert.match(html, /data-ui="home-tasks"/);
    assert.match(html, /id="laundry-activity-title"[^>]*>진행 중</);
    assert.match(html, /aria-labelledby="home-alerts-title"/);
    assert.match(html, /id="home-alerts-title"[^>]*>생활 알림</);
    assert.doesNotMatch(html, /id="home-(?:tasks|alerts)-title"[^>]*>할 일</);
    assert.ok(ddayStart >= 0);
    assert.ok(activityStart >= 0);
    assert.ok(activityStart < ddayStart);
    assert.ok(alertsStart > ddayEnd);
    assert.match(html, /x-text="homeTasks\.count"/);
    assert.match(html, /x-show="dashboard\.laundry"/);
    assert.match(html, /class="ui-progress/);
    assert.match(html, /:value="laundryProgress\(\) \?\? 0"/);
    assert.match(html, /:aria-valuetext="laundryProgressText\(\)"/);
    assert.match(html, /data-task="meal-alert"/);
    assert.match(html, /x-show="homeTasks\.mealAlerts > 0"/);
    assert.match(html, /x-for="alert in dashboard\.mealAlerts"/);
    assert.match(html, /x-text="alert\.title"/);
    assert.match(html, /x-text="alert\.preview"/);
    assert.match(html, /@click="perform\('open_laundry'\)"/);
    assert.match(html, /@click="perform\('open_meals'\)"/);
    assert.match(html, /@click\.prevent\.stop="stopLaundryTracking\(\)"/);
    assert.match(html, /@click\.prevent\.stop="dismissMealAlert\(alert\.id\)"/);
    assert.match(html, /aria-label="세탁 추적 종료"/);
    assert.match(html, /:aria-label="`\$\{alert\.period === 'lunch' \? '중식' : '석식'\} 알림 제거`"/);
    assert.doesNotMatch(html, /급식 알림 끄기|dismissHomeTask\('meals'\)/);
    assert.doesNotMatch(html, /data-task="laundry"|homeTasks\.laundry|dismissHomeTask/);
    assert.doesNotMatch(html, /data-task="attendance"|homeTasks\.attendance/);
    assert.match(html, /data-ui="home-task-error"/);
    assert.match(html, /role="alert"/);
    assert.match(html, /정보 갱신 지연/);
    assert.match(script, /stopLaundryTracking/);
    assert.match(script, /set_laundry_watch/);
    assert.doesNotMatch(script, /get_settings_snapshot|homeTaskDismissal|homeTaskSubscriptions|withoutHomeTask|dismissHomeTask/);
    assert.match(script, /dismissMealAlert/);
    assert.match(script, /dismiss_meal_alert/);
    assert.match(script, /local-dashboard-updated/);
    assert.match(script, /get_local_dashboard_snapshot/);
    assert.match(script, /window\.setInterval/);
    assert.match(script, /laundryDashboardProgress/);
    assert.match(script, /laundryProgress\(\)/);
    assert.match(script, /laundryProgressText\(\)/);
});

test('생활 알림과 생활 정보는 같은 섹션 제목 스타일을 사용한다', () => {
    const html = readFileSync(new URL('./tray-panel.html', import.meta.url), 'utf8');
    const alertTitle = html.match(/<h2 id="home-alerts-title" class="([^"]+)">생활 알림<\/h2>/);
    const campusTitle = html.match(/<h2 id="campus-action-title" class="([^"]+)">생활 정보<\/h2>/);
    const alertTitleClass = alertTitle?.[1];
    const campusTitleClass = campusTitle?.[1];

    assert.ok(alertTitleClass);
    assert.ok(campusTitleClass);
    assert.equal(alertTitleClass, campusTitleClass);
    assert.match(alertTitleClass, /\btext-xs\b/);
    assert.match(alertTitleClass, /\bfont-bold\b/);
    assert.match(alertTitleClass, /\btext-app-muted\b/);
    assert.match(
        html,
        /<section class="mt-4" aria-labelledby="campus-action-title">\s*<header class="mb-2 flex items-center justify-between px-1">/,
    );
});

test('트레이 패널은 공통 UI 프리미티브와 제한된 토큰을 사용한다', () => {
    const html = readFileSync(new URL('./tray-panel.html', import.meta.url), 'utf8');

    assert.match(html, /\bui-card\b/);
    assert.match(html, /\bui-button\b/);
    assert.match(html, /\bui-button--compact\b/);
    assert.match(html, /\bui-empty-state\b/);
    assert.match(html, /\bui-progress\b/);
    assert.doesNotMatch(html, /data-ui-density="micro"/);
    assert.doesNotMatch(html, /\btext-\[[0-9]+px\]/);
    assert.doesNotMatch(html, /\bfont-(?:thin|extralight|light|medium|semibold|extrabold|black)\b/);
    assert.doesNotMatch(html, /\b(?:text|bg)-(?:black|white)\b/);
    assert.doesNotMatch(html, /\b(?:m[trblxy]?|p[trblxy]?|gap)-\[[^\]]+\]/);
    assert.doesNotMatch(html, /\b(?:m[trblxy]?|p[trblxy]?|gap(?:-x|-y)?|space-[xy])-[0-9]+\.5\b/);
});

test('생활 알림에는 급식 항목만 여러 개 쌓이고 메뉴는 두 줄까지만 미리 보여준다', () => {
    const html = readFileSync(new URL('./tray-panel.html', import.meta.url), 'utf8');
    const alertsStart = html.indexOf('data-ui="home-tasks"');
    const alertsEnd = html.indexOf('</section>', alertsStart);
    const alerts = html.slice(alertsStart, alertsEnd);

    assert.match(alerts, /data-task="meal-alert"/);
    assert.match(alerts, /x-for="alert in dashboard\.mealAlerts"/);
    assert.doesNotMatch(alerts, /laundry|세탁/);
    assert.match(alerts, /\bline-clamp-2\b/);
    assert.match(alerts, /\bmin-h-14\b/);
    assert.match(alerts, /\bsize-8\b/);
    assert.match(alerts, /\bw-10\b/);
    assert.doesNotMatch(alerts, /\bmin-h-16\b|\bsize-9\b|\bpy-2\.5\b|\bw-11\b/);
});

test('트레이 홈은 세탁 추적 종료와 개별 급식 알림 제거에 필요한 권한만 가진다', () => {
    assert.ok(trayCapability.permissions.includes('allow-set-laundry-watch'));
    assert.ok(trayCapability.permissions.includes('allow-dismiss-meal-alert'));
    assert.ok(!trayCapability.permissions.includes('allow-get-settings-snapshot'));
    assert.ok(!trayCapability.permissions.includes('allow-set-meal-subscription-enabled'));
});

test('세탁 진행 카드는 남은 시간을 가장 크게, 기기와 예상 종료를 보조 정보로 표시한다', () => {
    const html = readFileSync(new URL('./tray-panel.html', import.meta.url), 'utf8');
    const activityStart = html.indexOf('data-ui="laundry-activity"');
    const activityEnd = html.indexOf('</section>', activityStart);
    const activity = html.slice(activityStart, activityEnd);

    assert.match(activity, /x-text="laundryRemaining\(\)"[^>]*class="[^"]*\btext-ui-title\b/);
    assert.match(activity, /dashboard\.laundry\.machineLabel/);
    assert.match(activity, /x-text="laundryExpectedEnd\(\)"/);
    assert.match(activity, />추적 종료</);
    assert.doesNotMatch(activity, /<path d="m7 7 10 10M17 7 7 17"/);
});

test('출석은 생활 알림이 아니라 항상 보이는 단일 상태 카드로 유지한다', () => {
    const html = readFileSync(new URL('./tray-panel.html', import.meta.url), 'utf8');
    const attendanceMarker = html.indexOf('data-ui="attendance-status"');
    const attendanceStart = html.lastIndexOf('<button', attendanceMarker);
    const attendanceEnd = html.indexOf('</button>', attendanceMarker) + 9;
    const attendanceCard = html.slice(attendanceStart, attendanceEnd);
    const attendanceOpeningTag = attendanceCard.slice(0, attendanceCard.indexOf('>') + 1);
    const tasksStart = html.indexOf('data-ui="home-tasks"');

    assert.ok(attendanceMarker >= 0);
    assert.ok(tasksStart > attendanceEnd);
    assert.doesNotMatch(attendanceOpeningTag, /x-show=|x-cloak/);
    assert.doesNotMatch(attendanceCard, /dismissHomeTask/);
    assert.match(attendanceCard, /perform\('open_attendance'\)/);
});

test('출석 상태 카드는 다른 홈 카드와 같은 밀도로 표시한다', () => {
    const html = readFileSync(new URL('./tray-panel.html', import.meta.url), 'utf8');
    const attendanceMarker = html.indexOf('data-ui="attendance-status"');
    const attendanceStart = html.lastIndexOf('<button', attendanceMarker);
    const attendanceEnd = html.indexOf('</button>', attendanceMarker) + 9;
    const attendanceCard = html.slice(attendanceStart, attendanceEnd);
    const attendanceOpeningTag = attendanceCard.slice(0, attendanceCard.indexOf('>') + 1);

    assert.match(attendanceOpeningTag, /\bmin-h-14\b/);
    assert.match(attendanceOpeningTag, /\bpx-3\b/);
    assert.match(attendanceOpeningTag, /\bpy-2\b/);
    assert.match(attendanceCard, /\bsize-9\b/);
    assert.match(attendanceCard, /\btext-ui-label\b/);
    assert.match(attendanceCard, /\btext-ui-caption\b/);
    assert.doesNotMatch(attendanceCard, /\bsize-10\b|\btext-ui-title\b/);
});
