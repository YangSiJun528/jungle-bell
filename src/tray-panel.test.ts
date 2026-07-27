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
    assert.match(attendanceCard, /text-xs[^"]*text-app-muted/);
    assert.doesNotMatch(attendanceCard, /<strong[^>]*x-text="state\.statusText"/);
    assert.doesNotMatch(attendanceCard, /presentation\.label/);
    assert.match(attendanceCard, /data-icon="chevron-right"/);
    assert.doesNotMatch(attendanceCard, /<footer|x-text="presentation\.actionLabel/);
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

test('홈은 선택된 세탁과 급식 구독만 동적 카드로 표시한다', () => {
    const html = readFileSync(new URL('./tray-panel.html', import.meta.url), 'utf8');
    const script = readFileSync(new URL('./tray-panel.ts', import.meta.url), 'utf8');

    assert.match(html, /data-ui="tracked-laundry"/);
    assert.match(html, /data-ui="subscribed-meals"/);
    assert.match(html, /dashboard\.laundry/);
    assert.match(html, /dashboard\.meals/);
    assert.match(html, /정보 갱신 지연/);
    assert.match(script, /local-dashboard-updated/);
    assert.match(script, /get_local_dashboard_snapshot/);
    assert.match(script, /window\.setInterval/);
});
