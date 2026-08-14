import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {test} from 'vitest';

const srcRoot = new URL('../../', import.meta.url);
const source = (path: string) => readFileSync(new URL(path, srcRoot), 'utf8');
const globals = source('./app/styles/globals.css');
const main = source('./app/main.tsx');
const dashboard = source('./index.html');

test('Pretendard Variable은 저장소의 woff2 파일에서 한 번만 선언한다', () => {
    assert.equal(existsSync(new URL('./assets/fonts/PretendardVariable.woff2', srcRoot)), true);
    assert.equal((globals.match(/@font-face/g) ?? []).length, 1);
    assert.match(globals, /font-family:\s*["']Pretendard Variable["']/);
    assert.match(globals, /url\(["']\.\.\/\.\.\/assets\/fonts\/PretendardVariable\.woff2["']\)/);
    assert.match(globals, /format\(["']woff2-variations["']\)/);
    assert.match(globals, /font-weight:\s*45 920/);
    assert.match(globals, /font-display:\s*swap/);
});

test('Tailwind font-sans와 body는 번들 폰트 및 크로스 플랫폼 fallback을 공유한다', () => {
    assert.match(
        globals,
        /--font-sans:\s*["']Pretendard Variable["'],\s*Pretendard,\s*-apple-system,\s*BlinkMacSystemFont,\s*system-ui,\s*sans-serif/,
    );
    assert.match(globals, /body\s*\{[\s\S]*@apply[^;]*font-sans/);
    assert.match(main, /import ['"]\.\/styles\/globals\.css['"]/);
    assert.doesNotMatch(dashboard, /<link[^>]+(?:googleapis|fonts\.)/i);
    assert.match(dashboard, /rel="license" href="\.\/assets\/fonts\/Pretendard-LICENSE\.txt"/);
});

test('화면 컴포넌트는 font-family를 개별 지정하지 않고 전역 타이포그래피를 상속한다', () => {
    const componentSources = [
        './app/shell/DashboardShell.tsx',
        './features/home/home-page.tsx',
        './features/attendance/attendance-page.tsx',
        './features/laundry/pages/laundry-page.tsx',
        './features/meals/pages/meals-page.tsx',
        './features/notifications/notifications-page.tsx',
        './features/connections/connections-page.tsx',
    ].map(source).join('\n');

    assert.doesNotMatch(componentSources, /font-family\s*:/i);
    assert.doesNotMatch(componentSources, /\b(?:Roboto|Inter|Noto Sans|SF Pro|Cascadia Code)\b/i);
    assert.match(componentSources, /tabular-nums/);
});
