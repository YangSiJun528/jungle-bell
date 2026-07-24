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
    const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
    const uiStyles = readFileSync(new URL('./ui.css', import.meta.url), 'utf8');
    const attendanceCardStart = html.indexOf('data-ui="attendance-status"');
    const attendanceCardEnd = html.indexOf('</article>', attendanceCardStart);
    const attendanceCard = html.slice(attendanceCardStart, attendanceCardEnd);
    const ddayCardStart = html.indexOf('data-ui="dday"');

    assert.match(html, /rounded-\[20px\]/);
    assert.match(html, /<main\s+class="[^"]*\bshadow-none\b[^"]*"/);
    assert.match(html, /<main\s+class="[^"]*\bbg-app-bg\b[^"]*"/);
    assert.doesNotMatch(html, /<main\s+class="[^"]*\bbg-app-overlay\b[^"]*"/);
    assert.match(html, /<img class="size-8[^"]*" src="assets\/logo\.png"/);
    assert.match(html, /activeTab === 'home' \? 'bg-app-surface text-app-accent shadow-sm'/);
    assert.match(html, /activeTab === 'news' \? 'bg-app-surface text-app-accent shadow-sm'/);
    assert.doesNotMatch(html, /activeTab === '(?:home|news)' \? 'bg-app-accent text-white shadow-sm'/);
    assert.match(html, /role="tablist"/);
    assert.match(html, />홈</);
    assert.match(html, />\s*소식\s*<span/);
    assert.match(html, />새 소식</);
    assert.match(html, /등록된 소식이 없어요/);
    assert.match(html, /bg-app-info-soft/);
    assert.match(html, /newsItems/);
    assert.match(html, /openNewsItem/);
    assert.match(html, /perform\('open_discussions'\)/);
    assert.match(html, /Discussions에서 이야기하기/);
    assert.ok(attendanceCardStart >= 0);
    assert.match(attendanceCard, /perform\('open_attendance'\)/);
    assert.match(attendanceCard, /출석 상태 확인/);
    assert.doesNotMatch(attendanceCard, /state\.ddayText/);
    assert.ok(ddayCardStart > attendanceCardEnd);
    assert.match(html.slice(ddayCardStart), /state\.ddayText/);
    assert.doesNotMatch(html, /quick-action-title/);
    assert.match(html, /워시타워/);
    assert.match(html, /오늘의 식단/);
    assert.match(html, /환경설정/);
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
