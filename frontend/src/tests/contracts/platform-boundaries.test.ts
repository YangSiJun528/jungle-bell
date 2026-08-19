import {existsSync, globSync, readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {describe, expect, test} from 'vitest';

const frontendRoot = resolve(import.meta.dirname, '../../..');
const repositoryRoot = resolve(frontendRoot, '..');
const readFrontend = (path: string) => readFileSync(resolve(frontendRoot, path), 'utf8');

describe('repository platform boundaries', () => {
    test('server, frontend, and desktop are independent top-level projects', () => {
        for (const directory of ['server', 'frontend', 'desktop']) {
            expect(existsSync(resolve(repositoryRoot, directory)), directory).toBe(true);
        }
        for (const removed of [
            'src', 'src-tauri', 'package.json', 'package-lock.json',
            'vite.config.ts', 'tsconfig.json', 'components.json',
        ]) {
            expect(existsSync(resolve(repositoryRoot, removed)), removed).toBe(false);
        }
    });

    test('common React and HTTP code do not reach into native or browser capability APIs', () => {
        const commonFiles = globSync(
            'src/{api,app,components,domain,features,hooks,lib}/**/*.{ts,tsx}',
            {cwd: frontendRoot},
        ).filter((path) => !path.includes('.test.'));
        const forbidden = /@tauri-apps|__TAURI_INTERNALS__|navigator\.serviceWorker|\bPushManager\b|Notification\.requestPermission/u;
        for (const path of commonFiles) {
            expect(readFrontend(path), path).not.toMatch(forbidden);
        }
    });

    test('web and desktop entry modules inject adapters into one shared bootstrap', () => {
        const entry = readFrontend('src/main.ts');
        const bootstrap = readFrontend('src/app/bootstrap.tsx');
        const web = readFrontend('src/platform/web/entry.ts');
        const desktop = readFrontend('src/platform/tauri/entry.ts');

        expect(entry).toMatch(/__JUNGLE_BELL_TARGET__ === 'desktop'/u);
        expect(entry).toMatch(/import\('@\/platform\/tauri\/entry'\)/u);
        expect(entry).toMatch(/import\('@\/platform\/web\/entry'\)/u);
        expect(web).toMatch(/bootstrapDashboard\(createWebPlatformAdapter\(pwa\)\)/u);
        expect(desktop).toMatch(/bootstrapDashboard\(createTauriPlatformAdapter\(\)\)/u);
        expect(bootstrap).toMatch(/<DashboardProviders platform=\{platform\}>/u);
    });

    test('desktop API origin은 fallback 없는 컴파일 타임 계약이다', () => {
        const buildConfig = readFrontend('src/platform/build-config.ts');
        const dashboardApi = readFrontend('src/api/dashboard-api.ts');
        const nativeDataApi = readFileSync(resolve(repositoryRoot, 'desktop/src/data_api.rs'), 'utf8');

        expect(buildConfig).toContain('__JUNGLE_BELL_BUILD_CONFIG__');
        expect(buildConfig).toContain("buildConfig.target === 'desktop'");
        expect(dashboardApi).toContain('platformApiBaseUrl');
        expect(dashboardApi).not.toContain('VITE_PLATFORM_API_URL');
        expect(nativeDataApi).toMatch(/env!\(\s*"JUNGLE_BELL_DATA_API_URL"/u);
        expect(nativeDataApi).not.toContain('option_env!("JUNGLE_BELL_DATA_API_URL")');
        expect(nativeDataApi).not.toContain('DEFAULT_DEV_API_ORIGIN');
    });

    test('기수 변경은 LMS 창 표시 여부와 무관하게 checker 재조회를 즉시 요청한다', () => {
        const commands = readFileSync(resolve(repositoryRoot, 'desktop/src/commands.rs'), 'utf8');
        const cohortChange = commands.match(
            /if previous\.selected_cohort_id != saved\.selected_cohort_id \{([\s\S]*?)\n    \}/u,
        )?.[1] ?? '';

        expect(cohortChange).toContain('checker::trigger_current_check(&app).await');
        expect(cohortChange).not.toContain('checker::refresh_webview');
    });

    test('프론트엔드와 Tauri는 같은 04시 출석일 경계를 사용한다', () => {
        const frontendAttendanceDay = readFrontend('src/domain/attendance/attendance-day.ts');
        const desktopConfig = readFileSync(resolve(repositoryRoot, 'desktop/src/config.rs'), 'utf8');
        const frontendHour = frontendAttendanceDay.match(/ATTENDANCE_DAY_START_HOUR_KST\s*=\s*(\d+)/u)?.[1];
        const desktopHour = desktopConfig.match(/MORNING_START_HOUR:\s*u32\s*=\s*(\d+)/u)?.[1];

        expect(frontendHour).toBe('4');
        expect(frontendHour).toBe(desktopHour);
    });

    test('PC 로컬 관측과 서버 snapshot은 같은 15분 freshness를 사용한다', () => {
        const frontendFreshness = readFrontend('src/domain/attendance/freshness.ts');
        const accountService = readFileSync(
            resolve(repositoryRoot, 'server/core/src/main/kotlin/app/junglebell/server/domain/account/AccountService.kt'),
            'utf8',
        );

        expect(frontendFreshness).toMatch(/ATTENDANCE_FRESHNESS_MS\s*=\s*15 \* 60_000/u);
        expect(accountService).toContain('attendanceFreshness = Duration.ofMinutes(15)');
    });

    test('PC 출석은 로컬 관측을 먼저 발행하고 서버 동기화 완료를 별도로 알린다', () => {
        const commands = readFileSync(resolve(repositoryRoot, 'desktop/src/commands.rs'), 'utf8');
        const remoteSync = readFileSync(resolve(repositoryRoot, 'desktop/src/remote_sync.rs'), 'utf8');
        const refreshPlatformSync = remoteSync.match(
            /pub\(crate\) async fn refresh_platform_sync[\s\S]*?\n\}/u,
        )?.[0] ?? '';
        const uploadAndPublish = remoteSync.match(
            /async fn upload_attendance_and_publish[\s\S]*?\n\}/u,
        )?.[0] ?? '';

        expect(commands).toContain('publish_attendance_observation(&app, snapshot)');
        expect(refreshPlatformSync).toContain('service.observation_revision');
        expect(refreshPlatformSync).toContain('service.wait_for_observation_after(baseline)');
        expect(refreshPlatformSync).not.toContain('ensure_registered');
        expect(uploadAndPublish).toContain('service.upload_attendance(snapshot).await?');
        expect(uploadAndPublish).toContain('AttendanceSnapshotUpdated::Synced');
        expect(uploadAndPublish.indexOf('service.upload_attendance(snapshot).await?'))
            .toBeLessThan(uploadAndPublish.indexOf('AttendanceSnapshotUpdated::Synced'));
    });

    test('frontend scripts and Tauri hooks use separate web and desktop UI artifacts', () => {
        const packageJson = JSON.parse(readFrontend('package.json')) as {
            scripts: Record<string, string>;
        };
        const tauriConfig = JSON.parse(
            readFileSync(resolve(repositoryRoot, 'desktop/tauri.conf.json'), 'utf8'),
        ) as {
            build: {
                beforeDevCommand: {script: string; cwd: string};
                beforeBuildCommand: {script: string; cwd: string};
                frontendDist: string;
            };
        };

        expect(packageJson.scripts['build:web']).toContain('vite build --mode web');
        expect(packageJson.scripts['build:desktop-ui']).toContain('vite build --mode desktop');
        expect(tauriConfig.build.beforeDevCommand).toMatchObject({
            script: 'npm run dev:desktop-ui',
            cwd: '../frontend',
        });
        expect(tauriConfig.build.beforeBuildCommand).toMatchObject({
            script: 'npm run build:desktop-ui',
            cwd: '../frontend',
        });
        expect(tauriConfig.build.frontendDist).toBe('../frontend/dist/desktop');
    });
});
