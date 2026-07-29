import assert from 'node:assert/strict';
import {test} from 'vitest';

import {
    EMPTY_NOTIFICATION_INBOX,
    normalizeNotificationInboxSnapshot,
    notificationActionLabel,
    notificationItemLabel,
    notificationTimeLabel,
    notificationTriggerLabel,
} from './notification-inbox.ts';

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
    assert.deepEqual(EMPTY_NOTIFICATION_INBOX, {
        revision: 0,
        unreadCount: 0,
        items: [],
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

test('알림 시각은 오늘이면 시각, 이전 날짜면 짧은 날짜로 표시한다', () => {
    const now = Date.parse('2026-07-29T05:00:00Z');

    assert.equal(notificationTimeLabel(Date.parse('2026-07-29T04:24:00Z'), now), '13:24');
    assert.equal(notificationTimeLabel(Date.parse('2026-07-28T04:24:00Z'), now), '7.28.');
    assert.equal(notificationTimeLabel(Number.NaN, now), '');
});

test('알림 대상과 읽음 상태를 접근 가능한 이름으로 설명한다', () => {
    assert.equal(notificationActionLabel('openAttendance'), '출석 열기');
    assert.equal(notificationActionLabel('openLaundry'), '워시타워 열기');
    assert.equal(notificationActionLabel('openMeals'), '식단 열기');
    assert.equal(notificationActionLabel(null), '알림 읽기');
    assert.equal(notificationTriggerLabel(0), '알림, 읽지 않은 알림 없음');
    assert.equal(notificationTriggerLabel(3), '알림, 읽지 않은 알림 3개');
    assert.equal(notificationItemLabel({
        id: '1',
        title: '세탁 완료',
        body: '세탁물을 꺼내 주세요.',
        createdAt: Date.parse('2026-07-29T04:24:00Z'),
        readAt: null,
        action: 'openLaundry',
    }), '읽지 않음, 세탁 완료, 워시타워 열기');
});
