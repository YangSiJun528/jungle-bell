import assert from 'node:assert/strict';
import {test} from 'vitest';

import {
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
        items: [{
            id: '1',
            title: '제목',
            body: '본문',
            createdAt: Date.parse('2026-07-29T04:24:00Z'),
            readAt: null,
            action: 'openAttendance',
        }],
    };

    assert.equal(normalizeNotificationInboxSnapshot({...base, revision: -1}), null);
    assert.equal(normalizeNotificationInboxSnapshot({...base, unreadCount: 0}), null);
    assert.equal(normalizeNotificationInboxSnapshot({...base, legacyUnread: 1}), null);
    assert.equal(normalizeNotificationInboxSnapshot({
        ...base,
        items: [{...base.items[0], legacyAction: 'openLaundry'}],
    }), null);
    assert.equal(normalizeNotificationInboxSnapshot({
        ...base,
        items: [{...base.items[0], id: 'notification-1'}],
    }), null);
    assert.equal(normalizeNotificationInboxSnapshot({
        ...base,
        items: [{...base.items[0], createdAt: Number.NaN}],
    }), null);
    assert.equal(normalizeNotificationInboxSnapshot({
        ...base,
        items: [{...base.items[0], readAt: 0}],
    }), null);
    assert.equal(normalizeNotificationInboxSnapshot({
        ...base,
        items: [{...base.items[0], action: 'openSettings'}],
    }), null);
});
