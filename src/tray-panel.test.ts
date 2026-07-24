import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'vitest';
import {
    newsItemLabel,
    newsCount,
    statusPresentation,
    type NewsItem,
    type TrayPanelState,
} from './tray-panel-state.ts';

const traySource = readFileSync(new URL('../src-tauri/src/tray.rs', import.meta.url), 'utf8');
const tauriConfig = JSON.parse(
    readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'),
) as {app: {macOSPrivateApi?: boolean}};

function panelState(overrides: Partial<TrayPanelState> = {}): TrayPanelState {
    return {
        status: 'loading',
        statusText: '상태 확인 중...',
        ddayText: 'D-day 확인 중...',
        currentVersion: '0.4.4',
        pendingUpdate: null,
        ...overrides,
    };
}

test('현재 상태에 따라 강조 톤과 출석 CTA를 결정한다', () => {
    assert.deepEqual(statusPresentation('needsLogin'), {
        label: '로그인 필요',
        tone: 'warning',
        actionLabel: '로그인하기',
    });
    assert.deepEqual(statusPresentation('active'), {
        label: '출석 확인 필요',
        tone: 'danger',
        actionLabel: '출석 페이지 열기',
    });
    assert.deepEqual(statusPresentation('complete'), {
        label: '오늘 출석 완료',
        tone: 'success',
        actionLabel: null,
    });
});

test('소식 배지는 출석 상태와 분리해 새 업데이트만 집계한다', () => {
    assert.equal(newsCount(panelState()), 0);
    assert.equal(newsCount(panelState({status: 'active'})), 0);
    assert.equal(newsCount(panelState({status: 'needsLogin'})), 0);
    assert.equal(newsCount(panelState({pendingUpdate: '0.5.0'})), 1);
});

test('Discussion 소식과 앱 업데이트를 각각 읽지 않은 항목으로 집계한다', () => {
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

    assert.equal(newsCount(panelState({pendingUpdate: '0.5.0'}), items, []), 3);
    assert.equal(newsCount(panelState({pendingUpdate: '0.5.0'}), items, ['discussion-12']), 2);
    assert.equal(newsCount(panelState({pendingUpdate: '0.5.0'}), items, items.map((item) => item.id)), 1);
    assert.equal(
        newsCount(panelState({pendingUpdate: '0.5.0'}), items, [...items.map((item) => item.id), 'release-0.5.0']),
        0,
    );
    assert.equal(newsItemLabel(items[0]!), '공지');
    assert.equal(newsItemLabel(items[1]!), '설문');
});

test('트레이 패널은 홈과 소식 화면 및 기존 주요 액션을 제공한다', () => {
    const html = readFileSync(new URL('./tray-panel.html', import.meta.url), 'utf8');
    const script = readFileSync(new URL('./tray-panel.ts', import.meta.url), 'utf8');
    const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
    const uiStyles = readFileSync(new URL('./ui.css', import.meta.url), 'utf8');
    const attendanceCardStart = html.indexOf('data-ui="attendance-status"');
    const attendanceCardEnd = html.indexOf('</article>', attendanceCardStart);
    const attendanceCard = html.slice(attendanceCardStart, attendanceCardEnd);
    const ddayCardStart = html.indexOf('data-ui="dday"');
    const laundryActionStart = html.indexOf('@click="perform(\'open_laundry\')"');
    const laundryActionEnd = html.indexOf('</button>', laundryActionStart);
    const laundryAction = html.slice(laundryActionStart, laundryActionEnd);
    const mealsActionStart = html.indexOf('@click="perform(\'open_meals\')"');
    const mealsActionEnd = html.indexOf('</button>', mealsActionStart);
    const mealsAction = html.slice(mealsActionStart, mealsActionEnd);
    const panelHeader = html.slice(html.indexOf('<header'), html.indexOf('</header>') + 9);
    const appMenuStart = panelHeader.indexOf('data-ui="app-menu"');
    const appMenu = panelHeader.slice(appMenuStart);

    assert.match(html, /rounded-\[20px\]/);
    assert.match(html, /<main\s+class="[^"]*\bshadow-none\b[^"]*"/);
    assert.match(html, /<main\s+class="[^"]*\bbg-app-bg\b[^"]*"/);
    assert.doesNotMatch(html, /<main\s+class="[^"]*\bbg-app-overlay\b[^"]*"/);
    assert.match(html, /<img class="size-8[^"]*" src="assets\/logo\.png"/);
    assert.match(html, /activeTab === 'home' \? 'text-app-accent after:bg-app-accent'/);
    assert.match(html, /activeTab === 'news' \? 'text-app-accent after:bg-app-accent'/);
    assert.doesNotMatch(html, /activeTab === '(?:home|news)' \? 'bg-app-(?:surface|accent)/);
    assert.match(html, /<nav class="[^"]*\bflex\b[^"]*" role="tablist"/);
    assert.doesNotMatch(html, /<nav class="[^"]*(?:grid-cols-2|bg-app-control)[^"]*" role="tablist"/);
    assert.match(html, /after:absolute after:inset-x-0 after:bottom-0/);
    assert.match(html, />홈</);
    assert.match(html, />\s*소식\s*<span/);
    assert.match(html, />새 소식</);
    assert.match(html, /등록된 소식이 없어요/);
    assert.match(html, /bg-app-info-soft/);
    assert.match(html, /newsItems/);
    assert.match(html, /openNewsItem/);
    assert.doesNotMatch(html, /perform\('open_discussions'\)|궁금해요에 질문하기/);
    assert.doesNotMatch(script, /\|\s*'open_discussions'/);
    assert.doesNotMatch(traySource, /OpenDiscussions|DISCUSSIONS_URL/);
    assert.ok(attendanceCardStart >= 0);
    assert.match(attendanceCard, /perform\('open_attendance'\)/);
    assert.match(attendanceCard, /출석 상태 확인/);
    assert.match(attendanceCard, /data-icon="chevron-right"/);
    assert.doesNotMatch(attendanceCard, /state\.ddayText/);
    assert.ok(ddayCardStart > attendanceCardEnd);
    assert.match(html.slice(ddayCardStart), /state\.ddayText/);
    assert.doesNotMatch(html, /quick-action-title/);
    assert.match(html, /워시타워/);
    assert.match(html, /오늘의 식단/);
    assert.match(laundryAction, /data-icon="chevron-right"/);
    assert.match(mealsAction, /data-icon="chevron-right"/);
    assert.match(panelHeader, /aria-label="앱 메뉴"/);
    assert.match(panelHeader, /data-icon="nut"/);
    assert.doesNotMatch(panelHeader, /data-icon="bolt"/);
    assert.doesNotMatch(panelHeader, /aria-label="패널 닫기"/);
    assert.doesNotMatch(panelHeader, /@click="hide\(\)"/);
    assert.match(panelHeader, /@click="toggleMenu\(\)"/);
    assert.match(appMenu, /role="menu"/);
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
    assert.match(script, /window\.addEventListener\('blur',\s*\(\)\s*=>\s*this\.closeMenu\(\)\)/);
    assert.doesNotMatch(html, /<footer class="flex h-12/);
    assert.match(styles, /--jungle-info:/);
    assert.match(uiStyles, /--color-app-info:/);
    assert.doesNotMatch(html, /트레이에서 상태와 새 소식을 한 번에/);
    assert.doesNotMatch(html, /업데이트와 중요한 소식을 모아볼 수 있어요/);
    assert.doesNotMatch(html, /릴리즈 노트 예시/);
    assert.doesNotMatch(html, /LMS에서 시작·종료 체크하기/);
    assert.doesNotMatch(html, /이 패널에 의견 보내기/);
    assert.doesNotMatch(html, /출석 알림/);
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
