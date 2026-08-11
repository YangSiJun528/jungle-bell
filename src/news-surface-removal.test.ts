import assert from 'node:assert/strict';
import {existsSync, readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'vitest';

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

function filesBelow(directory: string): string[] {
    return readdirSync(directory, {withFileTypes: true}).flatMap((entry) => {
        const path = join(directory, entry.name);
        return entry.isDirectory() ? filesBelow(path) : [path];
    });
}

const dashboardHtml = source('./dashboard.html');
const dashboardApp = source('./app/dashboard-app.tsx');
const homePage = source('./features/home/home-page.tsx');
const dashboardApi = source('./dashboard-api.ts');
const dashboardCapability = source('../src-tauri/capabilities/dashboard.json');
const buildScript = source('../src-tauri/build.rs');
const appSource = source('../src-tauri/src/lib.rs');
const tauriConfig = source('../src-tauri/tauri.conf.json');
const astroConfig = source('../astro.config.mjs');
const packageJson = source('../package.json');

test('React 대시보드와 Tauri IPC에는 제거된 앱 소식 기능이 남지 않는다', () => {
    for (const item of [dashboardHtml, dashboardApp, homePage, dashboardApi]) {
        assert.doesNotMatch(item, /getNewsFeed|openNewsItem|DashboardNews|newsState|newsItems/);
    }
    for (const item of [dashboardCapability, buildScript, appSource]) {
        assert.doesNotMatch(item, /get_news_feed|open_news_item|NewsService/);
    }
    assert.equal(existsSync(new URL('../src-tauri/src/news.rs', import.meta.url)), false);
    assert.equal(existsSync(new URL('../.github/workflows/publish-news.yml', import.meta.url)), false);
});

test('소식 대신 Markdown 콘텐츠를 src/site 아래의 정적 Astro 블로그로 관리한다', () => {
    assert.equal(existsSync(new URL('./site/content/posts/welcome.md', import.meta.url)), true);
    assert.equal(existsSync(new URL('./site/pages/blog/index.astro', import.meta.url)), true);
    assert.equal(existsSync(new URL('./site/pages/blog/posts/[slug].astro', import.meta.url)), true);
    assert.equal(existsSync(new URL('../site/package.json', import.meta.url)), false);
    assert.equal(existsSync(new URL('../site/astro.config.mjs', import.meta.url)), false);
    assert.equal(existsSync(new URL('../site/src/pages/blog/index.astro', import.meta.url)), false);

    assert.match(astroConfig, /srcDir:\s*['"]\.\/src\/site['"]/);
    assert.match(astroConfig, /outDir:\s*['"]\.\/\.build\/site['"]/);
    assert.match(astroConfig, /output:\s*['"]static['"]/);
    assert.match(source('./site/content.config.ts'), /glob\(\{[\s\S]*pattern:\s*['"]\*\*\/\*\.md['"]/);
    assert.match(source('./site/pages/blog/index.astro'), /publishedPosts\(\)/);
});

test('정적 블로그는 React 통합과 hydration directive를 사용하지 않는다', () => {
    assert.doesNotMatch(astroConfig, /@astrojs\/react|integrations\s*:/);
    assert.doesNotMatch(packageJson, /@astrojs\/react/);

    const siteDirectory = fileURLToPath(new URL('./site/', import.meta.url));
    const siteSources = filesBelow(siteDirectory)
        .filter((path) => /\.(?:astro|ts)$/u.test(path) && !path.endsWith('.test.ts'));
    for (const path of siteSources) {
        const item = readFileSync(path, 'utf8');
        assert.doesNotMatch(item, /from\s+['"](?:react(?:-dom)?|@astrojs\/react)['"]/u, path);
        assert.doesNotMatch(item, /\bclient:(?:load|idle|visible|media|only)\b/u, path);
    }
});

test('블로그 코드는 React 대시보드 초기 모듈 그래프와 출력에서 분리한다', () => {
    const main = source('./app/main.tsx');
    assert.doesNotMatch(`${main}\n${dashboardApp}`, /(?:@\/site|src\/site|\.astro|blog\/)/);
    assert.match(dashboardApp, /lazy\(\(\) => import\(['"]@\/features\/home\/home-page['"]\)/);

    const assembler = source('../scripts/assemble-site.mjs');
    assert.match(assembler, /stagingRoot[\s\S]*['"]\.build['"][\s\S]*['"]site['"]/);
    assert.match(assembler, /new Set\(\['blog', 'blog-assets'\]\)/);
    assert.match(assembler, /copyTree\(stagingRoot\)/);
});

test('정적 블로그로 바꿔도 서명된 GitHub Release 앱 업데이트는 유지한다', () => {
    assert.match(tauriConfig, /github\.com\/YangSiJun528\/jungle-bell\/releases\/latest\/download\/latest\.json/);
    assert.match(appSource, /tauri_plugin_updater/);
    assert.match(appSource, /spawn_startup_update_check/);
});
