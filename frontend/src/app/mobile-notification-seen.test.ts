import assert from 'node:assert/strict';
import {test} from 'vitest';
import {
    mergeSeenMobileNotificationIds,
    readSeenMobileNotificationIds,
    writeSeenMobileNotificationIds,
} from './mobile-notification-seen';

function memoryStorage(initial: Record<string, string> = {}) {
    const values = new Map(Object.entries(initial));
    return {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => { values.set(key, value); },
        values,
    };
}

test('seen notification storage reads and writes the bounded current schema', () => {
    const storage = memoryStorage();
    writeSeenMobileNotificationIds(storage, new Set(['one', 'two']));
    const seen = readSeenMobileNotificationIds(storage);
    assert.deepEqual([...seen], ['one', 'two']);

    assert.equal(
        storage.values.get('jungle-bell:seen-mobile-notifications:v1'),
        JSON.stringify(['one', 'two']),
    );
});

test('seen notification merge preserves identity when no new IDs are added', () => {
    const current = new Set(['one', 'two']);
    assert.equal(mergeSeenMobileNotificationIds(current, ['two', 'one']), current);
    assert.deepEqual([...mergeSeenMobileNotificationIds(current, ['three'])], ['three', 'one', 'two']);
});

test('개별 알림을 본 처리하면 다른 새 알림은 유지한다', () => {
    const current = new Set(['one']);
    const next = mergeSeenMobileNotificationIds(current, ['two']);

    assert.deepEqual([...next], ['two', 'one']);
    assert.equal(next.has('three'), false);
});

test('새 알림 ID를 한 번에 병합하면 전체를 본 상태로 유지할 수 있다', () => {
    const current = new Set(['old']);
    const next = mergeSeenMobileNotificationIds(current, ['new-2', 'new-1']);

    assert.deepEqual([...next], ['new-2', 'new-1', 'old']);
});
