import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';

import {test} from 'vitest';

const srcRoot = new URL('../../', import.meta.url);
const source = (path: string) => readFileSync(new URL(path, srcRoot), 'utf8');
const packageJson = JSON.parse(source('../package.json')) as {
    scripts?: Record<string, string>;
    devDependencies?: Record<string, string>;
};

test('프론트엔드는 index.html 하나를 사용하는 React SPA다', () => {
    const index = source('../index.html');
    assert.match(index, /<div id="root"><\/div>/);
    assert.match(index, /src="\/src\/main\.ts"/);
    assert.equal(existsSync(new URL('./dashboard.html', srcRoot)), false);
    assert.equal(existsSync(new URL('./site', srcRoot)), false);
});

test('Astro 소스와 빌드 체계가 존재하지 않는다', () => {
    for (const path of [
        '../astro.config.mjs',
        '../tsconfig.site.json',
        '../scripts/assemble-site.mjs',
    ])
        assert.equal(existsSync(new URL(path, srcRoot)), false, path);

    assert.equal(packageJson.devDependencies?.astro, undefined);
    assert.equal(packageJson.devDependencies?.['cross-env'], undefined);
    for (const script of ['build:site', 'assemble:site', 'check:site']) {
        assert.equal(packageJson.scripts?.[script], undefined);
    }
});

test('React 앱과 Spring 공개 컨트롤러에 블로그 경로가 남지 않는다', () => {
    const sources = [
        source('./app/dashboard-app.tsx'),
        source('./app/shell/DashboardFooter.tsx'),
        source('./platform/pwa/service-worker/sw.js'),
        source(
            '../../server/api/src/main/kotlin/app/junglebell/server/api/publicapi/PublicDataController.kt',
        ),
    ];
    for (const item of sources) assert.doesNotMatch(item, /\/blog(?:\/|\b)/u);
});

test('제거된 앱 소식 IPC 없이 서명된 v2 앱 업데이트를 유지한다', () => {
    const dashboardApi = source('./api/dashboard-api.ts');
    const dashboardApp = source('./app/dashboard-app.tsx');
    const dashboardCapability = source('../../desktop/capabilities/dashboard.json');
    const buildScript = source('../../desktop/build.rs');
    const appSource = source('../../desktop/src/lib.rs');
    const tauriConfig = source('../../desktop/tauri.conf.json');

    for (const item of [dashboardApi, dashboardCapability, buildScript, appSource]) {
        assert.doesNotMatch(item, /get_news_feed|open_news_item|NewsService/);
    }
    assert.equal(existsSync(new URL('../../desktop/src/news.rs', srcRoot)), false);
    assert.match(
        tauriConfig,
        /github\.com\/YangSiJun528\/jungle-bell\/releases\/latest\/download\/latest-v2\.json/,
    );
    assert.match(appSource, /tauri_plugin_updater/);
    assert.match(appSource, /spawn_startup_update_check/);
    assert.match(dashboardApp, /DesktopUpdateNotice/);
    assert.match(dashboardCapability, /allow-check-desktop-update/);
    assert.match(dashboardCapability, /allow-install-desktop-update/);
});
