import {describe, expect, test} from 'vitest';

import {
    NOTIFICATION_TEST_QUERY_KEY,
    readNotificationTestRecord,
    writeNotificationTestRecord,
} from './notification-test-history';

function memoryStorage() {
    const entries = new Map<string, string>();
    return {
        getItem: (key: string) => entries.get(key) ?? null,
        setItem: (key: string, value: string) => entries.set(key, value),
        removeItem: (key: string) => entries.delete(key),
    };
}

describe('notification test history', () => {
    test('canonical push 결과와 실제 확인 시각을 재시작 뒤 복원한다', () => {
        const storage = memoryStorage();
        const record = writeNotificationTestRecord(storage, {
            surface: 'pwa',
            state: {status: 'arrived'},
            testedAt: '2026-09-08T02:03:04.000Z',
        });

        expect(NOTIFICATION_TEST_QUERY_KEY).toEqual(['notification-test-result']);
        expect(readNotificationTestRecord(storage)).toEqual(record);
    });

    test('다른 버전, 알 수 없는 상태, 확장 필드는 복원하지 않는다', () => {
        const storage = memoryStorage();
        for (const value of [
            {version: 2, surface: 'pwa', state: {status: 'arrived'}, testedAt: '2026-09-08'},
            {version: 1, surface: 'pwa', state: {status: 'ready'}, testedAt: '2026-09-08'},
            {
                version: 1,
                surface: 'pwa',
                state: {status: 'arrived'},
                testedAt: '2026-09-08T02:03:04.000Z',
                endpoint: 'https://secret.example',
            },
        ]) {
            storage.setItem('jungle-bell.notification-test-result', JSON.stringify(value));
            expect(readNotificationTestRecord(storage)).toBeNull();
        }
    });
});
