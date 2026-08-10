import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {test} from 'vitest';

const dashboardHtml = readFileSync(new URL('./dashboard.html', import.meta.url), 'utf8');
const dashboardScript = readFileSync(new URL('./dashboard.ts', import.meta.url), 'utf8');
const dashboardApi = readFileSync(new URL('./dashboard-api.ts', import.meta.url), 'utf8');
const dashboardCapability = readFileSync(
    new URL('../src-tauri/capabilities/dashboard.json', import.meta.url),
    'utf8',
);
const buildScript = readFileSync(new URL('../src-tauri/build.rs', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
const tauriConfig = readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8');

test('대시보드와 Tauri IPC에는 앱 소식 기능이 남지 않는다', () => {
    for (const source of [dashboardHtml, dashboardScript, dashboardApi]) {
        assert.doesNotMatch(source, /getNewsFeed|openNewsItem|DashboardNews|newsState|newsItems/);
    }
    for (const source of [dashboardCapability, buildScript, appSource]) {
        assert.doesNotMatch(source, /get_news_feed|open_news_item|NewsService/);
    }
    assert.equal(existsSync(new URL('../src-tauri/src/news.rs', import.meta.url)), false);
    assert.equal(existsSync(new URL('../.github/workflows/publish-news.yml', import.meta.url)), false);
});

test('앱 소식을 제거해도 서명된 GitHub Release 업데이트는 유지한다', () => {
    assert.match(tauriConfig, /github\.com\/YangSiJun528\/jungle-bell\/releases\/latest\/download\/latest\.json/);
    assert.match(appSource, /tauri_plugin_updater/);
    assert.match(appSource, /spawn_startup_update_check/);
});
