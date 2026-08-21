import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';

import {test} from 'vitest';

const srcRoot = new URL('../../', import.meta.url);
const viteConfig = readFileSync(new URL('../vite.config.ts', srcRoot), 'utf8');

test('트레이 클릭은 dashboard를 열며 별도 tray-panel frontend entry는 없다', () => {
    assert.doesNotMatch(viteConfig, /trayPanel|tray-panel\.html/);
    for (const path of [
        './tray-panel.html',
        './tray-panel.ts',
        './tray-panel-state.ts',
        './tray-panel-overview.ts',
    ]) {
        assert.equal(existsSync(new URL(path, srcRoot)), false, `${path}가 남아 있습니다.`);
    }
});

test('웹 대시보드는 별도 이미지 뷰어 frontend entry를 만들지 않는다', () => {
    assert.doesNotMatch(viteConfig, /imageViewer|image-viewer\.html/);
    for (const path of ['./image-viewer.html', './image-viewer']) {
        assert.equal(existsSync(new URL(path, srcRoot)), false, `${path}가 남아 있습니다.`);
    }
});
