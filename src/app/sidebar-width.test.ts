import assert from 'node:assert/strict';
import {test} from 'vitest';

import {
    DEFAULT_SIDEBAR_WIDTH,
    MAX_SIDEBAR_WIDTH,
    MIN_SIDEBAR_WIDTH,
    normalizeSidebarWidth,
    readSidebarWidth,
    sidebarWidthFromKey,
    sidebarWidthFromPointer,
    SIDEBAR_WIDTH_STORAGE_KEY,
    writeSidebarWidth,
} from './sidebar-width';

function memoryStorage(initial: Record<string, string> = {}) {
    const values = new Map(Object.entries(initial));
    return {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => { values.set(key, value); },
        values,
    };
}

test('사이드바 폭은 허용 범위와 8px 간격으로 정규화한다', () => {
    assert.equal(normalizeSidebarWidth(Number.NaN), DEFAULT_SIDEBAR_WIDTH);
    assert.equal(normalizeSidebarWidth(100), MIN_SIDEBAR_WIDTH);
    assert.equal(normalizeSidebarWidth(400), MAX_SIDEBAR_WIDTH);
    assert.equal(normalizeSidebarWidth(237), 240);
});

test('사이드바 폭은 방향키와 Home, End 키로 조절한다', () => {
    assert.equal(sidebarWidthFromKey(232, 'ArrowLeft'), 224);
    assert.equal(sidebarWidthFromKey(232, 'ArrowDown'), 224);
    assert.equal(sidebarWidthFromKey(232, 'ArrowRight'), 240);
    assert.equal(sidebarWidthFromKey(232, 'ArrowUp'), 240);
    assert.equal(sidebarWidthFromKey(232, 'Home'), MIN_SIDEBAR_WIDTH);
    assert.equal(sidebarWidthFromKey(232, 'End'), MAX_SIDEBAR_WIDTH);
    assert.equal(sidebarWidthFromKey(232, 'Enter'), null);
});

test('사이드바 폭은 포인터의 트랙 위치에 맞춰 조절한다', () => {
    assert.equal(sidebarWidthFromPointer(0, 0, 100), MIN_SIDEBAR_WIDTH);
    assert.equal(sidebarWidthFromPointer(50, 0, 100), 256);
    assert.equal(sidebarWidthFromPointer(100, 0, 100), MAX_SIDEBAR_WIDTH);
    assert.equal(sidebarWidthFromPointer(-20, 0, 100), MIN_SIDEBAR_WIDTH);
    assert.equal(sidebarWidthFromPointer(120, 0, 100), MAX_SIDEBAR_WIDTH);
    assert.equal(sidebarWidthFromPointer(50, 0, 0), null);
});

test('사이드바 폭은 versioned localStorage 키에 보존하고 안전하게 복구한다', () => {
    const storage = memoryStorage();
    writeSidebarWidth(storage, 280);

    assert.equal(storage.values.get(SIDEBAR_WIDTH_STORAGE_KEY), '280');
    assert.equal(readSidebarWidth(storage), 280);
    assert.equal(readSidebarWidth(memoryStorage({[SIDEBAR_WIDTH_STORAGE_KEY]: 'invalid'})), DEFAULT_SIDEBAR_WIDTH);
});
