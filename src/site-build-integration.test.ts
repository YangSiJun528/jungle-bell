import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {test} from 'vitest';

const rootPackage = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as {workspaces?: string[]; scripts?: Record<string, string>};
const assembler = readFileSync(new URL('../site/scripts/assemble.mjs', import.meta.url), 'utf8');
const appBlog404 = new URL('../dist/blog/404.html', import.meta.url);

test('Markdown 사이트는 루트 workspace의 App asset build에 포함된다', () => {
    assert.deepEqual(rootPackage.workspaces, ['site']);
    assert.match(rootPackage.scripts?.build ?? '', /build:app/);
    assert.match(rootPackage.scripts?.build ?? '', /build:site/);
    assert.match(rootPackage.scripts?.build ?? '', /assemble:site/);
    assert.match(rootPackage.scripts?.['build:site'] ?? '', /@jungle-bell\/site/);
});

test('사이트 조립은 Vite build 후 staging 출력만 dist에 병합한다', () => {
    assert.match(assembler, /site[/'"`, ]+dist/);
    assert.match(assembler, /copyFile/);
    assert.match(assembler, /already exists/);
    assert.equal(existsSync(new URL('../.github/workflows/deploy-site.yml', import.meta.url)), false);
});

test('통합 App asset에는 Cloudflare가 인식하는 blog/404.html이 생성된다', () => {
    assert.equal(existsSync(appBlog404), true);
    assert.match(readFileSync(appBlog404, 'utf8'), /페이지를 찾을 수 없어요/);
});
