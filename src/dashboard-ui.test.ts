import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'vitest';

const html = readFileSync(new URL('./dashboard.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('./dashboard.css', import.meta.url), 'utf8');
const script = readFileSync(new URL('./dashboard.ts', import.meta.url), 'utf8');

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
});

test('알림 화면은 서버 계획과 PC 오프라인 fallback을 설명한다', () => {
    const notifications = html.slice(
        html.indexOf('data-dashboard-page="notifications"'),
        html.indexOf('data-dashboard-page="connections"'),
    );
    assert.match(notifications, /10분 전/);
    assert.match(notifications, /출석 시간/);
    assert.match(notifications, /PC.*연결.*않|PC.*오프라인/);
    assert.match(notifications, /모바일.*푸시/);
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
    assert.match(css, /@media\s*\(max-width:\s*719px\)/);
    assert.match(css, /env\(safe-area-inset-bottom/);
    assert.match(css, /prefers-reduced-motion/);
    assert.match(css, /:focus-visible/);
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

test('일반 웹은 공개 정보와 앱 설치 안내만 제공한다', () => {
    assert.match(html, /일반 웹사이트에서는 PC와 모바일 모두 출석 상태 확인, 출석 체크 알림, 세탁 알림을 제공하지 않습니다/);
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

test('정글캠퍼스는 웹·PWA에서는 바로가기, PC 앱에서는 내부 열기를 제공한다', () => {
    assert.match(html, /href="https:\/\/jungle-lms\.krafton\.com\/check-in"/);
    assert.match(html, /target="_blank" rel="noopener noreferrer"/);
    assert.match(html, /surface\.kind === 'desktop'[^>]*@click="openLmsLogin\(\)"/);
});
