import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {test} from 'vitest';

const viteConfig = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8');
const uiCss = readFileSync(new URL('./ui.css', import.meta.url), 'utf8');

test('트레이 클릭은 dashboard를 열며 별도 tray-panel frontend entry는 없다', () => {
    assert.doesNotMatch(viteConfig, /trayPanel|tray-panel\.html/);
    assert.doesNotMatch(uiCss, /@source\s+["']\.\/tray-panel\.html["']/);
    for (const path of [
        './tray-panel.html',
        './tray-panel.ts',
        './tray-panel-state.ts',
        './tray-panel-overview.ts',
    ]) {
        assert.equal(existsSync(new URL(path, import.meta.url)), false, `${path}가 남아 있습니다.`);
    }
});
