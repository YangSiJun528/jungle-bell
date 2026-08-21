import assert from 'node:assert/strict';

import {test} from 'vitest';

import {
    markAllNotificationInboxItemsRead,
    markNotificationInboxItemRead,
    normalizeNotificationInboxSnapshot,
} from './inbox';

test('알림함 snapshot은 백엔드 스키마와 일치하는 값만 허용한다', () => {
    const snapshot = normalizeNotificationInboxSnapshot({
        revision: 3,
        unreadCount: 1,
        items: [
            {
                id: '2',
                title: '세탁 완료',
                body: '3번 세탁기의 세탁이 끝났습니다.',
                createdAt: Date.parse('2026-07-29T04:24:00Z'),
                readAt: null,
                action: 'openLaundry',
            },
            {
                id: '1',
                title: '업데이트 완료',
                body: '새 버전으로 업데이트했습니다.',
                createdAt: Date.parse('2026-07-28T04:24:00Z'),
                readAt: Date.parse('2026-07-28T04:25:00Z'),
                action: null,
            },
        ],
    });

    assert.deepEqual(snapshot, {
        revision: 3,
        unreadCount: 1,
        items: [
            {
                id: '2',
                title: '세탁 완료',
                body: '3번 세탁기의 세탁이 끝났습니다.',
                createdAt: Date.parse('2026-07-29T04:24:00Z'),
                readAt: null,
                action: 'openLaundry',
            },
            {
                id: '1',
                title: '업데이트 완료',
                body: '새 버전으로 업데이트했습니다.',
                createdAt: Date.parse('2026-07-28T04:24:00Z'),
                readAt: Date.parse('2026-07-28T04:25:00Z'),
                action: null,
            },
        ],
    });
});

test('알림함 snapshot은 잘못된 ID, 시각, 액션과 미읽음 개수 불일치를 거부한다', () => {
    const base = {
        revision: 1,
        unreadCount: 1,
        items: [
            {
                id: '1',
                title: '제목',
                body: '본문',
                createdAt: Date.parse('2026-07-29T04:24:00Z'),
                readAt: null,
                action: 'openAttendance',
            },
        ],
    };

    assert.equal(normalizeNotificationInboxSnapshot({...base, revision: -1}), null);
    assert.equal(normalizeNotificationInboxSnapshot({...base, unreadCount: 0}), null);
    assert.equal(normalizeNotificationInboxSnapshot({...base, legacyUnread: 1}), null);
    assert.equal(
        normalizeNotificationInboxSnapshot({
            ...base,
            items: [{...base.items[0], legacyAction: 'openLaundry'}],
        }),
        null,
    );
    assert.equal(
        normalizeNotificationInboxSnapshot({
            ...base,
            items: [{...base.items[0], id: 'notification-1'}],
        }),
        null,
    );
    assert.equal(
        normalizeNotificationInboxSnapshot({
            ...base,
            items: [{...base.items[0], createdAt: Number.NaN}],
        }),
        null,
    );
    assert.equal(
        normalizeNotificationInboxSnapshot({
            ...base,
            items: [{...base.items[0], readAt: 0}],
        }),
        null,
    );
    assert.equal(
        normalizeNotificationInboxSnapshot({
            ...base,
            items: [{...base.items[0], action: 'openSettings'}],
        }),
        null,
    );
});

test('알림 본 처리는 해당 항목과 미읽음 개수만 낙관적으로 갱신한다', () => {
    const snapshot = normalizeNotificationInboxSnapshot({
        revision: 2,
        unreadCount: 2,
        items: [
            {
                id: '2',
                title: '둘',
                body: '본문',
                createdAt: 1_000,
                readAt: null,
                action: null,
            },
            {
                id: '1',
                title: '하나',
                body: '본문',
                createdAt: 900,
                readAt: null,
                action: null,
            },
        ],
    });
    assert.ok(snapshot);

    const next = markNotificationInboxItemRead(snapshot, '2', 2_000);
    assert.notEqual(next, snapshot);
    assert.equal(next.unreadCount, 1);
    assert.equal(next.items[0]?.readAt, 2_000);
    assert.equal(next.items[1]?.readAt, null);
    assert.equal(markNotificationInboxItemRead(next, '2', 3_000), next);
    assert.equal(markNotificationInboxItemRead(next, 'missing', 3_000), next);
});

test('새 알림 전체 본 처리는 읽지 않은 항목만 같은 시각으로 갱신한다', () => {
    const snapshot = normalizeNotificationInboxSnapshot({
        revision: 3,
        unreadCount: 2,
        items: [
            {
                id: '3',
                title: '셋',
                body: '본문',
                createdAt: 1_100,
                readAt: null,
                action: null,
            },
            {
                id: '2',
                title: '둘',
                body: '본문',
                createdAt: 1_000,
                readAt: 1_500,
                action: null,
            },
            {
                id: '1',
                title: '하나',
                body: '본문',
                createdAt: 900,
                readAt: null,
                action: null,
            },
        ],
    });
    assert.ok(snapshot);

    const next = markAllNotificationInboxItemsRead(snapshot, 2_000);
    assert.notEqual(next, snapshot);
    assert.equal(next.unreadCount, 0);
    assert.deepEqual(
        next.items.map((item) => item.readAt),
        [2_000, 1_500, 2_000],
    );
    assert.equal(markAllNotificationInboxItemsRead(next, 3_000), next);
});
