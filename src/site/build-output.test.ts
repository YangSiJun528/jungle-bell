import assert from 'node:assert/strict';
import {existsSync, readFileSync, readdirSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'vitest';

const workspaceRoot = new URL('../../', import.meta.url);
const stagingDist = new URL('../../.build/site/', import.meta.url);
const appDist = new URL('../../dist/', import.meta.url);
const builtOutputAvailable = existsSync(new URL('blog/index.html', stagingDist))
    && existsSync(new URL('blog/index.html', appDist));
const outputTest = builtOutputAvailable ? test : test.skip;

async function read(base: URL, relativePath: string): Promise<string> {
    return readFile(new URL(relativePath, base), 'utf8');
}

function sourceFiles(directory: string): string[] {
    return readdirSync(directory, {withFileTypes: true}).flatMap((entry) => {
        const path = join(directory, entry.name);
        return entry.isDirectory() ? sourceFiles(path) : [path];
    });
}

test('Astro는 src/site를 독립된 정적 사이트로 빌드한다', () => {
    const astroConfig = readFileSync(new URL('astro.config.mjs', workspaceRoot), 'utf8');
    const siteTsconfig = readFileSync(new URL('tsconfig.site.json', workspaceRoot), 'utf8');

    assert.match(astroConfig, /srcDir:\s*['"]\.\/src\/site['"]/);
    assert.match(astroConfig, /outDir:\s*['"]\.\/\.build\/site['"]/);
    assert.match(astroConfig, /output:\s*['"]static['"]/);
    assert.doesNotMatch(astroConfig, /@astrojs\/react|integrations\s*:/);
    assert.match(siteTsconfig, /src\/site\/\*\*\/\*/);
});

test('블로그 소스에는 React import와 Astro hydration directive가 없다', () => {
    const directory = fileURLToPath(new URL('./', import.meta.url));
    const files = sourceFiles(directory)
        .filter((path) => /\.(?:astro|ts)$/u.test(path) && !path.endsWith('.test.ts'));

    for (const file of files) {
        const source = readFileSync(file, 'utf8');
        assert.doesNotMatch(source, /from\s+['"](?:react(?:-dom)?|@astrojs\/react)['"]/u, file);
        assert.doesNotMatch(source, /\bclient:(?:load|idle|visible|media|only)\b/u, file);
    }
});

outputTest('한국어 글 목록, 상세 페이지와 사용자 지정 404를 생성한다', async () => {
    const [index, detail, notFound] = await Promise.all([
        read(stagingDist, 'blog/index.html'),
        read(stagingDist, 'blog/posts/welcome/index.html'),
        read(stagingDist, 'blog/404/index.html'),
    ]);

    assert.match(index, /<html lang="ko">/);
    assert.match(index, /Jungle Bell 이야기/);
    assert.match(index, /Jungle Bell 소식 페이지를 시작합니다/);
    assert.match(index, /href="\/blog\/posts\/welcome\/index\.html"/);
    const indexCanonical = /<link rel="canonical" href="([^"]+)">/u.exec(index)?.[1];
    assert.ok(indexCanonical);
    assert.equal(new URL(indexCanonical).pathname, '/blog/index.html');
    assert.match(detail, /서비스 업데이트와 이용 안내를 한곳에서/);
    const detailCanonical = /<link rel="canonical" href="([^"]+)">/u.exec(detail)?.[1];
    assert.ok(detailCanonical);
    assert.equal(new URL(detailCanonical).pathname, '/blog/posts/welcome/index.html');
    assert.match(detail, /href="\/blog\/api\/posts\.json"/);
    assert.match(notFound, /페이지를 찾을 수 없어요/);
    assert.match(notFound, /href="\/blog\/index\.html"/);
    const notFoundCanonical = /<link rel="canonical" href="([^"]+)">/u.exec(notFound)?.[1];
    assert.ok(notFoundCanonical);
    assert.equal(new URL(notFoundCanonical).pathname, '/blog/404.html');
});

outputTest('안정적인 글 목록과 Markdown 상세 JSON 계약을 게시한다', async () => {
    const [list, detail] = await Promise.all([
        read(stagingDist, 'blog/api/posts.json'),
        read(stagingDist, 'blog/api/posts/welcome.json'),
    ]).then((files) => files.map((file) => JSON.parse(file)));

    assert.equal(list.version, 1);
    assert.equal(list.posts.length, 1);
    assert.deepEqual(Object.keys(list.posts[0]).sort(), [
        'category',
        'description',
        'publishedAt',
        'slug',
        'tags',
        'title',
        'updatedAt',
    ]);
    assert.equal(list.posts[0].slug, 'welcome');
    assert.equal('bodyMarkdown' in list.posts[0], false);

    assert.equal(detail.version, 1);
    assert.equal(detail.post.slug, 'welcome');
    assert.match(detail.post.bodyMarkdown, /^Jungle Bell/m);
    assert.equal('bodyHtml' in detail.post, false);
});

outputTest('유효한 RSS와 React 런타임 없는 HTML을 게시한다', async () => {
    const [rss, index, detail] = await Promise.all([
        read(stagingDist, 'blog/rss.xml'),
        read(stagingDist, 'blog/index.html'),
        read(stagingDist, 'blog/posts/welcome/index.html'),
    ]);

    assert.match(rss, /<rss[^>]+version="2\.0"/);
    assert.match(rss, /Jungle Bell 소식 페이지를 시작합니다/);
    assert.match(rss, /\/blog\/index\.html/);
    assert.match(rss, /\/blog\/posts\/welcome\/index\.html/);

    for (const html of [index, detail]) {
        assert.doesNotMatch(html, /<script\b/iu);
        assert.doesNotMatch(html, /rel=["']modulepreload["']/iu);
        assert.doesNotMatch(html, /dashboard-[^"'\s>]+\.js/iu);
        assert.doesNotMatch(html, /<link[^>]+rel="stylesheet"[^>]+https?:\/\//iu);
    }
});

outputTest('사이트 staging 출력만 충돌 없이 App asset에 병합한다', () => {
    const assembler = readFileSync(new URL('scripts/assemble-site.mjs', workspaceRoot), 'utf8');
    const appBlog404 = new URL('dist/blog/404.html', workspaceRoot);

    assert.match(assembler, /\.build['"`, ]+['"`]site/);
    assert.match(assembler, /new Set\(\['blog', 'blog-assets'\]\)/);
    assert.match(assembler, /copyFile/);
    assert.match(assembler, /already exists/);
    assert.equal(existsSync(new URL('.github/workflows/deploy-site.yml', workspaceRoot)), false);
    assert.equal(existsSync(appBlog404), true);
    assert.match(readFileSync(appBlog404, 'utf8'), /페이지를 찾을 수 없어요/);
});
