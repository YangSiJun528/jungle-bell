import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'vitest';

const srcRoot = new URL('../../', import.meta.url);
const source = (path: string) => readFileSync(new URL(path, srcRoot), 'utf8');

const html = source('./dashboard.html');
const main = source('./app/main.tsx');
const app = source('./app/dashboard-app.tsx');
const context = source('./app/dashboard-context.tsx');
const providers = source('./app/dashboard-providers.tsx');
const queries = source('./app/use-dashboard-queries.ts');
const campusQueryOptions = source('./app/campus-query-options.ts');
const routes = source('./app/routes.ts');
const shell = source('./app/shell/DashboardShell.tsx');
const installPrompt = source('./app/install-prompt.tsx');
const home = source('./features/home/home-page.tsx');
const jungleCampusSummary = source('./features/home/jungle-campus-summary.tsx');
const attendance = source('./features/attendance/attendance-page.tsx');
const attendancePreferences = source('./features/attendance/attendance-preferences-section.tsx');
const laundry = source('./features/laundry/pages/laundry-page.tsx');
const personalLaundry = source('./features/laundry/components/personal-laundry-section.tsx');
const washTower = source('./features/laundry/components/wash-tower-grid.tsx');
const meals = source('./features/meals/pages/meals-page.tsx');
const mealPreferences = source('./features/meals/components/meal-preferences-section.tsx');
const notifications = source('./features/notifications/notifications-page.tsx');
const connections = source('./features/connections/connections-page.tsx');
const notificationSettings = source('./app/settings/notification-settings.tsx');

test('대시보드는 Alpine 템플릿 대신 React root에서 시작한다', () => {
    assert.match(html, /<div id="root"><\/div>/);
    assert.match(html, /<script type="module" src="\/app\/main\.tsx"><\/script>/);
    assert.doesNotMatch(html, /\bx-(?:data|show|for|text|bind|on):?/);
    assert.doesNotMatch(html, /dashboard\.(?:ts|css)/);

    assert.match(main, /createRoot\(root\)\.render\(/);
    assert.match(main, /<StrictMode>/);
    assert.match(main, /<DashboardProviders>/);
    assert.match(main, /<DashboardApp\/>/);
    assert.match(main, /import ['"]\.\/styles\/globals\.css['"]/);
});

test('기능 화면은 공통 셸 아래에서 경로별 지연 로딩된다', () => {
    for (const feature of [
        'home/home-page',
        'attendance/attendance-page',
        'laundry/pages/laundry-page',
        'meals/pages/meals-page',
        'notifications/notifications-page',
        'connections/connections-page',
    ]) {
        assert.match(app, new RegExp(`lazy\\(\\(\\) => import\\(['"]@/features/${feature}['"]\\)`));
    }
    assert.match(app, /<DashboardShell[\s\S]*notificationPanel=\{\{[\s\S]*open: notificationPanelOpen[\s\S]*setNotificationPanelRequestedOpen\(open\)[\s\S]*route === 'notifications'\) replace\(contentRoute\)[\s\S]*<NotificationPanelContent[\s\S]*seenMobileIds=\{seenMobileIds\}[\s\S]*onMobileNotificationSeen=\{markMobileNotificationSeen\}[\s\S]*\/>[\s\S]*<RouteContent[\s\S]*route=\{contentRoute\}[\s\S]*onRequestInstall=\{openInstallPrompt\}[\s\S]*\/>[\s\S]*<InstallPrompt open=\{installPromptOpen\} onOpenChange=\{setInstallPromptVisibility\}\/>[\s\S]*<\/DashboardShell>/);
    assert.match(app, /useHashRoute\(surface\.kind\)/);
    assert.match(app, /window\.scrollTo\(\{top: 0, left: 0, behavior: 'auto'\}\)/);
    assert.match(shell, /data-dashboard-shell="renewal"/);
    assert.match(shell, /data-dashboard-surface=\{surface\}/);
});

test('공개 웹과 개인 앱은 하나의 경로 정책에서 노출 기능을 분리한다', () => {
    assert.match(routes, /PUBLIC_NAVIGATION_ROUTES\s*=\s*\[[\s\S]*'home'[\s\S]*'laundry'[\s\S]*'meals'[\s\S]*\]/);
    assert.match(routes, /PERSONAL_NAVIGATION_ROUTES\s*=\s*\[[\s\S]*'attendance'[\s\S]*'meals'[\s\S]*\]/);
    assert.doesNotMatch(routes, /PERSONAL_NAVIGATION_ROUTES\s*=\s*\[[^\]]*'notifications'/);
    assert.match(routes, /PERSONAL_UTILITY_ROUTES\s*=\s*\[[\s\S]*'notifications'[\s\S]*'connections'[\s\S]*\]/);
    assert.match(routes, /if \(surface === 'public'\) return PUBLIC_NAVIGATION_ROUTES/);
    assert.match(routes, /dashboardUtilityRoutes/);

    assert.match(shell, /const personal = surface !== 'public'/);
    assert.match(shell, /aria-label="개인 도구"/);
    assert.match(shell, /data-navigation-group="utilities"/);
    assert.match(shell, /md:hidden[\s\S]*aria-label=\{notificationAriaLabel/);
    assert.match(shell, /aria-label="설정"/);
    assert.match(shell, /aria-haspopup="dialog"/);
    assert.match(shell, /overlayClassName="backdrop-blur-sm"/);
    assert.match(shell, /<DashboardBottomNavigation[\s\S]*routes=\{bottomRoutes\}/);
    assert.match(shell, /routes\.map/);
});

test('홈은 정글캠퍼스·오늘 세탁·오늘 급식을 요약하고 알림 센터를 중복하지 않는다', () => {
    assert.match(home, /title="오늘 필요한 정보"/);
    for (const title of ['세탁실', '오늘 급식']) {
        assert.match(home, new RegExp(`title="${title}"`));
    }
    assert.match(home, /<JungleCampusSummary onRequestInstall=\{onRequestInstall\}\/>/);
    assert.match(jungleCampusSummary, /<h2[^>]*>정글캠퍼스<\/h2>/);
    assert.match(jungleCampusSummary, /data-home-campus-card="true"/);
    assert.match(jungleCampusSummary, /h-\[20rem\]/);
    assert.doesNotMatch(jungleCampusSummary, /공식 출석 상태와 Jungle Bell 동기화 결과/);
    assert.doesNotMatch(shell, /캠퍼스 생활 현황/);
    assert.match(jungleCampusSummary, /앱을 설치하고 PC와 연결하면 오늘 출석 상태를 확인할 수 있습니다/);
    for (const route of ['laundry', 'meals']) {
        assert.match(home, new RegExp(`href="#${route}"`));
    }
    assert.match(jungleCampusSummary, /href="#attendance"/);
    assert.doesNotMatch(home, /title="알림"|href="#notifications"/);
    assert.match(jungleCampusSummary, /surface\.kind === 'desktop'[\s\S]*openCampus\.mutate\(\)/);
    assert.match(jungleCampusSummary, /href=\{CAMPUS_URL\}[\s\S]*target="_blank"[\s\S]*rel="noopener noreferrer"/);
    assert.match(home, /useRefreshHomeMutation\(\)/);
    assert.match(home, /refreshHome\.isError/);
    assert.match(home, /전체 정보를 갱신하지 못했습니다/);
});

test('출석 화면은 조회 상태만 관리하고 공유 알림 설정을 중복하지 않는다', () => {
    assert.match(attendance, /if \(surface\.kind === 'public'\)/);
    assert.match(attendance, /웹사이트에는 출석 정보를 표시하지 않습니다/);
    assert.match(attendance, /오전[\s\S]*오후[\s\S]*마지막 동기화/);
    assert.match(attendance, /detail\.freshness === 'stale'/);
    assert.match(attendance, /PC 마지막 확인/);
    assert.match(attendance, /<CalendarCheck2 aria-hidden="true" className="size-5"\/>/);
    assert.doesNotMatch(attendance, /jungleCompassIcon|@\/assets\/logo\.png/);
    assert.match(attendance, /surface\.kind === 'desktop'[\s\S]*openCampus\.mutate\(\)/);

    assert.doesNotMatch(attendance, /AttendancePreferencesSection|getAttendancePreferences|updateAttendancePreferences/);
});

test('세탁 화면은 기존 워시타워 상태표를 유지하고 개인 기능만 앱에 제공한다', () => {
    assert.match(laundry, /<WashTowerGrid machines=\{snapshot\.machines\}\/>/);
    assert.match(laundry, /워시타워 상태/);
    assert.match(laundry, /data-laundry-zone-legend="true"/);
    for (const zone of ['men', 'common', 'women']) {
        assert.match(laundry, new RegExp(`<LaundryZoneBadge zone="${zone}"/>`));
    }
    assert.doesNotMatch(laundry, /1–5번 남성 · 6–7번 공용 · 8–9번 여성/);
    assert.match(washTower, /<table[\s\S]*<caption className="sr-only">워시타워 번호별 세탁기와 건조기 상태<\/caption>/);
    assert.match(washTower, /WASH_TOWER_ROWS\.map/);
    assert.match(washTower, /scope="col"/);
    assert.match(washTower, /scope="row"/);
    assert.match(washTower, /data-state=\{cell\.state\}/);
    assert.match(washTower, /data-zone=\{machine\.zone\}/);
    assert.match(washTower, /overflow-x-auto/);

    assert.match(laundry, /personal === null \? null[\s\S]*<PersonalLaundrySection[\s\S]*surface=\{personal\}[\s\S]*machines=\{snapshot\?\.machines \?\? \[\]\}/);
    assert.doesNotMatch(laundry, /use(?:Query|Mutation|QueryClient)/);
    assert.doesNotMatch(laundry, /api\.(?:list|create|delete|join|leave)Laundry/);
    assert.doesNotMatch(laundry, /as PersonalSurface/);

    assert.match(personalLaundry, /api\.listLaundryWatches\(surface\)/);
    assert.match(personalLaundry, /api\.listLaundryQueue\(surface\)/);
    assert.match(personalLaundry, /api\.createLaundryWatch\(surface,/);
    assert.match(personalLaundry, /api\.deleteLaundryWatch\(surface, id\)/);
    assert.match(personalLaundry, /api\.joinLaundryQueue\([\s\S]*surface,[\s\S]*\{machineId: null, appliance\}/);
    assert.match(personalLaundry, /api\.leaveLaundryQueue\(surface, id\)/);
    assert.doesNotMatch(personalLaundry, /as PersonalSurface/);
    assert.match(personalLaundry, /기기 예약이 아닌 사용자 간 순서 안내 기능/);
});

test('설정 알림 탭은 연결된 기기의 출석·급식 설정을 함께 제공한다', () => {
    assert.doesNotMatch(meals, /MealPreferencesSection/);
    assert.doesNotMatch(meals, /as PersonalSurface/);
    assert.match(connections, /<TabsTrigger value="notifications">알림<\/TabsTrigger>/);
    assert.match(connections, /<NotificationSettings surface=\{personalSurface\}\/>/);
    assert.match(notificationSettings, /<AttendancePreferencesSection surface=\{surface\}\/>/);
    assert.match(notificationSettings, /<MealPreferencesSection surface=\{surface\}\/>/);

    assert.match(attendancePreferences, /api\.getAttendancePreferences\(surface\)/);
    assert.match(attendancePreferences, /api\.updateAttendancePreferences\(surface, input\)/);
    for (const label of [
        '출석 알림 사용', '오전 알림', '오전 확인 시작 시각', '오전 확인 간격',
        '오후 알림', '오후 확인 종료 시각', '오후 확인 간격', '일요일 제외',
    ]) {
        assert.match(attendancePreferences, new RegExp(label));
    }

    assert.match(mealPreferences, /api\.getMealPreferences\(surface\)/);
    assert.match(mealPreferences, /api\.updateMealPreferences\(surface,/);
    for (const label of ['급식 알림 설정', '조식', '중식', '석식']) {
        assert.match(mealPreferences, new RegExp(label));
    }

    assert.match(notifications, /api\.sendDesktopTestNotification\(\)/);
    assert.match(notifications, /api\.sendMobileTestNotification\(\)/);
    assert.match(notifications, /api\.registerPushSubscription/);
    assert.match(notifications, /Notification\.requestPermission\(\)/);
    assert.match(notifications, /운영체제 알림/);
    assert.match(notifications, /푸시 연결/);
    assert.match(notifications, /테스트 알림/);
});

test('연결 화면은 PC의 QR·수동 코드와 PWA 연결 흐름을 명시적으로 분리한다', () => {
    assert.match(connections, /surface\.kind === 'desktop' \? <DesktopConnections\/> : <CompanionConnections\/>/);
    assert.match(connections, /api\.createMobilePairing\(\)/);
    assert.match(connections, /api\.approveMobilePairing/);
    assert.match(connections, /모바일 연결/);
    assert.match(connections, /10자리 코드/);
    assert.match(connections, /alt="모바일 연결 QR 코드"/);
    assert.match(connections, /inputMode="text"/);
    assert.match(connections, /placeholder="ABCDE-12345"/);
    assert.match(connections, /api\.claimManualPairing/);
    assert.match(connections, /api\.completePairing/);
    assert.match(connections, /api\.disconnectMobileSession\(\)/);
});

test('TanStack Query는 공개 데이터와 개인 데이터를 서로 다른 주기로 갱신한다', () => {
    assert.match(providers, /<QueryClientProvider client=\{queryClient\}>/);
    assert.match(context, /queryKeys\s*=\s*\{[\s\S]*laundry[\s\S]*meals[\s\S]*attendance[\s\S]*notifications/);
    assert.match(campusQueryOptions, /laundryQueryContract\s*=\s*\{[\s\S]{0,180}freshnessMs:\s*30_000/);
    assert.match(campusQueryOptions, /mealsQueryContract\s*=\s*\{[\s\S]{0,180}freshnessMs:\s*5 \* 60_000/);
    assert.match(queries, /personal:\s*60_000/);
    assert.match(queries, /enabled:\s*surface\.canViewAttendance/);
    assert.match(queries, /enabled:\s*surface\.canReceivePersonalNotifications/);
    assert.match(campusQueryOptions, /queryOptions\(\{[\s\S]{0,180}queryKey: laundryQueryContract\.queryKey,[\s\S]{0,180}staleTime: laundryQueryContract\.freshnessMs/);
    assert.match(campusQueryOptions, /queryOptions\(\{[\s\S]{0,180}queryKey: mealsQueryContract\.queryKey,[\s\S]{0,180}staleTime: mealsQueryContract\.freshnessMs/);
    assert.match(queries, /useQuery\(laundryQueryOptions\(api\)\)/);
    assert.match(queries, /useQuery\(mealsQueryOptions\(api\)\)/);
    assert.match(queries, /queryKey: queryKeys\.attendance\(personalSurface\),[\s\S]{0,220}staleTime: DASHBOARD_REFRESH\.personal/);
    assert.match(queries, /queryKey: queryKeys\.notifications\(personalSurface\),[\s\S]{0,260}staleTime: DASHBOARD_REFRESH\.personal/);

    assert.match(providers, /['"]notification-inbox-updated['"]/);
    assert.doesNotMatch(providers, /campus-data-(?:updated|error)/);
    assert.match(providers, /registerDesktopSubscriptions/);
    assert.doesNotMatch(providers, /report_campus_ready/);
    assert.doesNotMatch(providers, /TooltipProvider/);
    assert.doesNotMatch(context, /useCampusDataIssue|homeOverview/);
    assert.doesNotMatch(queries, /refreshCampusData|refreshHomeOverview|homeOverview/);
    assert.match(queries, /throwOnError:\s*true/);
    assert.match(queries, /useRefreshHomeMutation/);
    assert.match(queries, /api\.refreshPlatformSync\(\)/);
    assert.match(queries, /client\.refetchQueries/);
    assert.match(laundry, /useCampusManualRefresh\('laundry'\)/);
    assert.match(meals, /useCampusManualRefresh\('meals'\)/);
    assert.doesNotMatch(laundry, /campusIssue/);
    assert.doesNotMatch(meals, /campusIssue/);
});

test('PWA 메타데이터·서비스 워커·설치 프롬프트는 React 진입점과 함께 유지한다', () => {
    assert.match(html, /rel="manifest" href="\.\/manifest\.webmanifest"/);
    assert.match(html, /viewport-fit=cover/);
    assert.match(html, /apple-mobile-web-app-capable/);
    assert.match(html, /prefers-color-scheme: light/);
    assert.match(html, /prefers-color-scheme: dark/);
    assert.match(main, /navigator\.serviceWorker\.register\('\.\/sw\.js'/);
    assert.match(main, /!\('__TAURI_INTERNALS__' in window\)/);
    assert.match(installPrompt, /beforeinstallprompt/);
    assert.match(installPrompt, /surface\.kind !== 'public'/);
    assert.match(installPrompt, /홈 화면에 추가/);
    assert.match(installPrompt, /https:\/\/github\.com\/YangSiJun528\/jungle-bell\/releases\/latest/);
    assert.match(installPrompt, /PC 앱 다운로드/);
    assert.match(installPrompt, /useState\(false\)/);
    assert.match(installPrompt, /if \(!open\) return null/);
    assert.doesNotMatch(installPrompt, /설치 안내 다시 열기/);
    assert.equal(
        installPrompt.match(/bottom-\[calc\(env\(safe-area-inset-bottom\)\+4\.5rem\)\]/gu)?.length,
        1,
        '열린 안내만 모바일 하단 메뉴 및 safe area 위에 있어야 합니다.',
    );
    assert.doesNotMatch(installPrompt, /className="fixed (?:inset-x-3 )?bottom-3/);
    assert.match(app, /<RouteContent[\s\S]*route=\{contentRoute\}[\s\S]*onRequestInstall=\{openInstallPrompt\}/);
    assert.match(app, /<NotificationPanelContent[\s\S]*seenMobileIds=\{seenMobileIds\}[\s\S]*onMobileNotificationSeen=\{markMobileNotificationSeen\}[\s\S]*\/>/);
    assert.match(app, /<InstallPrompt open=\{installPromptOpen\} onOpenChange=\{setInstallPromptVisibility\}\/>/);
    assert.doesNotMatch(home, /홈 화면 추가·PC 앱 안내/);
    assert.match(home, /이 QR은 설치한 모바일 PWA에서 열어야 합니다/);
    assert.doesNotMatch(home, /PWA 설치 안내 열기/);
    assert.match(jungleCampusSummary, /앱 설치 안내/);
    assert.match(jungleCampusSummary, /data-home-campus-status-icon="true"/);
    assert.doesNotMatch(jungleCampusSummary, /jungleCompassIcon|@\/assets\/logo\.png/);
    assert.match(shell, /import jungleBellLogo from ['"]\.\.\/\.\.\/assets\/logo\.png['"]/);
    assert.doesNotMatch(jungleCampusSummary, /일반 웹에서는 출석 정보를/);
    assert.doesNotMatch(home, /세탁을 시작하고 60분 안에 건조까지/);
});
