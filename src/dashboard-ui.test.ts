import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'vitest';

const html = readFileSync(new URL('./dashboard.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('./dashboard.css', import.meta.url), 'utf8');
const script = readFileSync(new URL('./dashboard.ts', import.meta.url), 'utf8');
const foundationCss = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
const uiCss = readFileSync(new URL('./ui.css', import.meta.url), 'utf8');

test('대시보드는 탭 대신 왼쪽 사이드바에 핵심 화면을 모두 제공한다', () => {
    assert.match(html, /class="dashboard-sidebar"/);
    assert.match(html, /aria-label="정글벨 메뉴"/);
    for (const route of ['home', 'attendance', 'laundry', 'meals', 'notifications', 'connections']) {
        assert.match(html, new RegExp(`href="#${route}"`));
        assert.match(html, new RegExp(`data-dashboard-page="${route}"`));
    }
    assert.doesNotMatch(html, /role="tablist"/);
});

test('출석은 조회 snapshot만 표시하며 실행 기능을 제공하지 않는다', () => {
    const attendance = html.slice(
        html.indexOf('data-dashboard-page="attendance"'),
        html.indexOf('data-dashboard-page="laundry"'),
    );
    assert.match(attendance, /오전 출석/);
    assert.match(attendance, /오후 출석/);
    assert.match(attendance, /마지막 동기화/);
    assert.doesNotMatch(attendance, /자동\s*출석|출석\s*(?:실행|체크|시작)\s*(?:버튼|하기)?/);
    assert.doesNotMatch(html, /자동\s*출석/);
    assert.match(attendance, /attendanceFreshness === 'stale'/);
    assert.match(attendance, /시간이 지났어요/);
});

test('세탁은 상태 수식어 대신 남녀별 건조까지 바로 가능한 수를 명시한다', () => {
    const laundry = html.slice(
        html.indexOf('data-dashboard-page="laundry"'),
        html.indexOf('data-dashboard-page="meals"'),
    );
    assert.match(laundry, /건조까지 바로 가능한 수/);
    assert.match(laundry, /남성/);
    assert.match(laundry, /여성/);
    assert.doesNotMatch(laundry, /널널|넉넉|여유 있음/);
});

test('인증 화면은 출석·급식 알림과 세탁 watch를 같은 설정 계약으로 제공한다', () => {
    const attendance = html.slice(
        html.indexOf('data-dashboard-page="attendance"'),
        html.indexOf('data-dashboard-page="laundry"'),
    );
    const laundry = html.slice(
        html.indexOf('data-dashboard-page="laundry"'),
        html.indexOf('data-dashboard-page="meals"'),
    );
    const meals = html.slice(
        html.indexOf('data-dashboard-page="meals"'),
        html.indexOf('data-dashboard-page="notifications"'),
    );

    assert.match(attendance, /출석 알림 설정/);
    assert.match(attendance, /오전 알림/);
    assert.match(attendance, /오후 알림/);
    assert.match(attendance, /일요일 제외/);
    assert.match(attendance, /이번 출석일 건너뛰기/);
    assert.match(attendance, /saveAttendancePreferences\(\)/);
    assert.match(meals, /급식 알림 설정/);
    assert.match(meals, /조식/);
    assert.match(meals, /중식/);
    assert.match(meals, /석식/);
    assert.match(meals, /saveMealPreferences\(\)/);
    assert.match(laundry, /세탁 알림 추가/);
    assert.match(laundry, /addLaundryWatch\(\)/);
    assert.match(laundry, /cancelLaundryWatch\(watch\.id\)/);
    assert.match(script, /getAttendancePreferences|loadPersonalControls/);
});

test('자율 대기열은 외부 예약이나 우선권으로 오해되지 않게 5분 차례 알림으로 설명한다', () => {
    const laundry = html.slice(
        html.indexOf('data-dashboard-page="laundry"'),
        html.indexOf('data-dashboard-page="meals"'),
    );
    assert.match(laundry, /자율 대기열/);
    assert.match(laundry, /차례 알림/);
    assert.match(laundry, /5분/);
    assert.match(laundry, /실제 기기 예약/);
    assert.match(laundry, /우선권을 보장하지/);
    assert.match(laundry, /joinLaundryQueue\('washer'\)/);
    assert.match(laundry, /joinLaundryQueue\('dryer'\)/);
    assert.match(laundry, /leaveLaundryQueue\(entry\.id\)/);
});

test('일반 웹에는 개인 controls를 렌더링하지 않고 설치 안내만 노출한다', () => {
    for (const marker of [
        'data-personal-controls="attendance"',
        'data-personal-controls="laundry"',
        'data-personal-controls="meals"',
    ]) {
        const start = html.indexOf(marker);
        assert.ok(start >= 0, `${marker} 누락`);
        const tagStart = html.lastIndexOf('<article', start);
        const openTag = html.slice(tagStart, html.indexOf('>', start) + 1);
        assert.match(openTag, /x-show="surface\.kind !== 'public'"/);
    }
    assert.match(html, /개인 알림 기능은 모바일 앱\(PWA\)이나 PC 앱에서 사용할 수/);
});

test('연결 화면은 모바일 입력과 PC QR·10자리 코드·기기 해제를 함께 제공한다', () => {
    const connections = html.slice(html.indexOf('data-dashboard-page="connections"'));
    assert.match(connections, /inputmode="text"/i);
    assert.match(connections, /maxlength="11"/i);
    assert.match(connections, /10자리/);
    assert.match(connections, /data-ui="pairing-qr"/);
    assert.match(connections, /연결 해제/);
    assert.match(connections, /365일/);
    assert.match(script, /status\.status === 'expired'[\s\S]*pairingRemainingSeconds = 0/);
    assert.match(script, /연결 코드가 만료됐어요/);
    assert.match(script, /desktopPairingStatus\?\.status === 'expired'[\s\S]*return '만료됨'/);
    assert.match(script, /status\.status === 'completed'[\s\S]*clearInterval\(this\.desktopPairingTimer\)[\s\S]*desktopPairingTimer = null/);
    assert.match(connections, /desktopPairingStatus\?\.status !== 'completed'.*desktopPairingStatus\?\.status !== 'expired'/);
    assert.match(script, /personalRefreshTimer = window\.setInterval[\s\S]*loadDesktopConnection\(\)/);
    assert.match(connections, /desktopConnection\?\.state === 'reset-required'/);
    assert.match(connections, /새 PC 연결 정보를 만들어/);
    assert.match(script, /resetDesktopIdentity\(\)/);
});

test('PC 자동 실행은 연결 화면의 desktop 전용 current-only 설정으로 제공한다', () => {
    const connections = html.slice(html.indexOf('data-dashboard-page="connections"'));
    const desktopGridStart = connections.indexOf('x-show="surface.kind === \'desktop\'"');
    const companionGridStart = connections.indexOf('x-show="surface.kind === \'companion\'"');
    const desktopGrid = connections.slice(desktopGridStart, companionGridStart);
    assert.match(desktopGrid, /data-desktop-setting="auto-start"/);
    assert.match(desktopGrid, /PC 로그인 시 자동 실행/);
    assert.match(desktopGrid, /기본값은 꺼짐/);
    assert.match(desktopGrid, /updateAutoStart\(\$event\.currentTarget\.checked\)/);
    assert.doesNotMatch(connections.slice(companionGridStart), /data-desktop-setting="auto-start"/);
    assert.match(script, /api\.getDesktopSettings\(\)/);
    assert.match(script, /api\.updateDesktopSettings\(\{autoStart: checked\}\)/);
    assert.doesNotMatch(`${html}\n${script}`, /usageAnalytics|사용 분석|analytics.*toggle/i);
});

test('모바일 연결 대기는 HttpOnly cookie를 권한으로 두고 2분 안에 새로고침 복구한다', () => {
    assert.match(script, /restorePendingMobilePairing\(\)/);
    assert.match(script, /storePendingMobilePairing\(window\.sessionStorage/);
    assert.match(script, /api\.completePairing\(pending\.pairingId\)/);
    assert.match(script, /PENDING_MOBILE_PAIRING_TTL_MS/);
    assert.doesNotMatch(script, /claimReceipt|accessToken|Authorization|Bearer/);
});

test('정글캠퍼스 카드는 PC와 PWA에서 실제 LMS·heartbeat 상태를 구분해 표시한다', () => {
    const attendance = html.slice(
        html.indexOf('data-dashboard-page="attendance"'),
        html.indexOf('data-dashboard-page="laundry"'),
    );
    assert.match(attendance, /desktopConnectionLabel\(\)/);
    assert.match(attendance, /companionCampusLabel\(\)/);
    assert.match(attendance, /PC 마지막 확인/);
    assert.match(script, /lmsSessionState === 'login-required'/);
    assert.match(script, /device\.health === 'offline'/);
});

test('알림 화면은 서버 계획과 상태 미확인 경고의 전체 기기 전달을 설명한다', () => {
    const notifications = html.slice(
        html.indexOf('data-dashboard-page="notifications"'),
        html.indexOf('data-dashboard-page="connections"'),
    );
    assert.match(notifications, /10분 전/);
    assert.match(notifications, /출석 시간/);
    assert.match(notifications, /PC가 꺼져 있거나/);
    assert.match(notifications, /미확인 경고/);
    assert.match(notifications, /활성 PC와 모바일 PWA에 함께/);
    assert.match(notifications, /x-show="surface\.kind === 'companion'"/);
    assert.match(notifications, /notificationState === 'loading'/);
    assert.match(notifications, /notificationState === 'auth-required'/);
    assert.match(notifications, /notificationState === 'error'/);
    assert.match(notifications, /x-for="notification in notifications"/);
    assert.match(notifications, /x-for="notification in desktopNotificationInbox\.items"/);
    assert.match(notifications, /openDesktopNotification\(notification\)/);
    assert.match(notifications, /테스트 알림 보내기/);
    assert.match(notifications, /sendTestNotification\(\)/);
    assert.match(script, /mobileQueued/);
    assert.match(notifications, /createdAtEpochMs/);
    assert.match(script, /companionAuthenticationRequired\(error\)/);
    assert.match(script, /notificationState = 'auth-required'/);
});

test('사이드바는 데스크톱에 고정되고 작은 화면에서는 안전영역을 반영한 하단 내비게이션이 된다', () => {
    assert.match(css, /grid-template-columns:\s*216px\s+minmax\(0,\s*1fr\)/);
    assert.match(css, /@media\s*\(max-width:\s*760px\)/);
    assert.match(css, /\.dashboard-navigation\s*\{[^}]*grid-template-columns:\s*repeat\(6,\s*minmax\(0,\s*1fr\)\)/s);
    assert.match(css, /\[data-surface="public"\][^{]*\.dashboard-navigation\s*\{[^}]*repeat\(3,/s);
    assert.doesNotMatch(css, /\[data-nav-secondary\][^{]*display:\s*none/);
    assert.match(css, /env\(safe-area-inset-bottom/);
    assert.match(css, /prefers-reduced-motion/);
    assert.match(css, /:focus-visible/);
});

test('대시보드는 원본 Tauri UI의 디자인 토큰만 사용한다', () => {
    const definitions = new Set(
        [...`${foundationCss}\n${uiCss}\n${css}`.matchAll(/--([a-z0-9-]+)\s*:/giu)]
            .map((match) => match[1]),
    );
    const usages = [...css.matchAll(/var\(--([a-z0-9-]+)/giu)].map((match) => match[1]);
    for (const token of usages) {
        assert.equal(definitions.has(token), true, `정의되지 않은 CSS 토큰: --${token}`);
    }

    assert.doesNotMatch(css, /--space-5\b/);
    for (const match of css.matchAll(/font-size:\s*([^;}]+)/gu)) {
        assert.match(match[1] ?? '', /^var\(--font-size-(?:caption|label|body|title|display)\)$/);
    }
    for (const match of css.matchAll(/border-radius:\s*([^;}]+)/gu)) {
        assert.match(
            match[1] ?? '',
            /^(?:var\(--radius-(?:control|card|window)\)|var\(--space-3\)|50%|9998px|var\(--radius-(?:card|window)\) var\(--radius-(?:card|window)\) 0 0)$/,
        );
    }
});

test('문서에는 PWA 메타데이터와 서비스 워커 진입점이 있다', () => {
    assert.match(html, /rel="manifest" href="\.\/manifest\.webmanifest"/);
    assert.match(html, /name="theme-color"/);
    assert.match(html, /apple-mobile-web-app-capable/);
    assert.match(html, /src="\/dashboard\.ts"/);
});

test('홈은 오늘의 핵심 정보를 요약하고 각 상세 화면으로 연결한다', () => {
    const home = html.slice(
        html.indexOf('data-dashboard-page="home"'),
        html.indexOf('data-dashboard-page="attendance"'),
    );
    assert.match(home, /오늘 필요한 정보/);
    assert.match(home, /오늘 출석/);
    assert.match(home, /지금 세탁/);
    assert.match(home, /오늘 급식/);
    assert.match(home, /안 본 알림/);
    assert.match(home, /href="#attendance"/);
    assert.match(home, /href="#laundry"/);
    assert.match(home, /href="#meals"/);
    assert.match(home, /href="#notifications"/);
});

test('PC 홈은 제거된 트레이 패널의 D-Day·LMS·버전을 대체하고 소식 피드는 표시하지 않는다', () => {
    const home = html.slice(
        html.indexOf('data-dashboard-page="home"'),
        html.indexOf('data-dashboard-page="attendance"'),
    );
    assert.match(home, /data-dashboard-home="lms"/);
    assert.match(home, /homeLmsLabel\(\)/);
    assert.match(home, /data-dashboard-home="dday"/);
    assert.match(home, /homeDdayLabel\(\)/);
    assert.match(home, /homeDdayProgress/);
    assert.match(home, /완료[^<]*<[^>]+x-text="homeDdayProgress\?\.elapsed \?\? 0"/);
    assert.match(home, /남음[^<]*<[^>]+x-text="homeDdayProgress\?\.remaining \?\? 0"/);
    assert.doesNotMatch(home, /data-dashboard-home="news"|앱 소식|newsItems/);
    assert.doesNotMatch(script, /getNewsFeed|openNewsItem|newsState/);
    assert.match(html, /surface\.kind === 'desktop' \? `Jungle Bell v\$\{appVersion\}`/);
    assert.match(script, /api\.getDashboardHomeOverview\(\)/);
    assert.doesNotMatch(`${home}\n${script}`, /get_tray_overview|run_tray_panel_action|hide_tray_panel/);
});

test('D-Day는 로컬 상태 문구만 있어도 카드를 유지하고 진행률만 null-safe로 분기한다', () => {
    const start = html.indexOf('data-dashboard-home="dday"');
    const cardStart = html.lastIndexOf('<article', start);
    const cardEnd = html.indexOf('</article>', start) + '</article>'.length;
    const card = html.slice(cardStart, cardEnd);

    assert.match(card, /x-show="surface\.kind !== 'public' && homeDdayVisible\(\)"/);
    assert.match(card, /class="dashboard-dday-summary"[^>]*x-show="homeDdayProgress"/);
    assert.match(card, /class="dashboard-dday-calendar"[^>]*x-show="homeDdayProgress"/);
    assert.match(card, /homeDdayProgress\?\.elapsed \?\? 0/);
    assert.match(card, /homeDdayProgress\?\.remaining \?\? 0/);
    assert.doesNotMatch(card, /homeDdayProgress\.(?:elapsed|remaining)/);
    assert.match(script, /homeDdayVisible\(this: any\)[\s\S]*attendance\.ddayText/);
});

test('일반 웹은 공개 정보와 앱 설치 안내만 제공한다', () => {
    assert.match(html, /일반 웹사이트에서도 공개 급식·세탁 정보는 볼 수 있지만/);
    assert.match(html, /출석 상태 확인과 개인 출석·급식·세탁 알림은 제공하지 않습니다/);
    assert.match(html, /모바일 앱\(PWA\)[\s\S]*개인 출석·급식·세탁 푸시 알림/);
    assert.match(html, /PC 앱[\s\S]*출석 정보를 주기적으로 자동 동기화/);
    assert.match(html, /모바일 앱\(PWA\)/);
    assert.match(html, /PC 앱/);
    assert.match(html, /홈 화면에 추가/);
    assert.match(html, /data-dashboard-page="attendance" x-show="surface\.kind !== 'public'/);
    assert.match(html, /data-dashboard-page="notifications" x-show="surface\.kind !== 'public'/);
    assert.match(html, /data-dashboard-page="connections" x-show="surface\.kind !== 'public'/);
    assert.match(html, /x-show="surface\.kind === 'companion'"[^>]*@click="enablePush\(\)"/);
    assert.doesNotMatch(script, /probeMobileSession\(\)/);
    assert.match(script, /dashboardRouteForSurface\(window\.location\.hash, initialSurface\.kind\)/);
    assert.match(script, /window\.history\.replaceState[\s\S]*#\$\{this\.activeRoute\}/);
});

test('모바일 PWA에서도 PC 연결 관리는 하단 내비게이션에서 접근할 수 있다', () => {
    const connectionItem = html.slice(
        html.lastIndexOf('<li', html.indexOf('href="#connections"')),
        html.indexOf('</li>', html.indexOf('href="#connections"')) + 5,
    );
    assert.match(connectionItem, /href="#connections"/);
    assert.doesNotMatch(connectionItem, /data-nav-secondary/);
    assert.match(connectionItem, /navigationRouteVisible\('connections'\)/);
});

test('정글캠퍼스는 웹·PWA에서는 바로가기, PC 앱에서는 내부 열기를 제공한다', () => {
    assert.match(html, /href="https:\/\/jungle-lms\.krafton\.com\/check-in"/);
    assert.match(html, /target="_blank" rel="noopener noreferrer"/);
    assert.match(html, /surface\.kind === 'desktop'[^>]*@click="openLmsLogin\(\)"/);
});
