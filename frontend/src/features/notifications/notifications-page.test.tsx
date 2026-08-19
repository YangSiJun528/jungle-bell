import {readFileSync} from 'node:fs';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, test} from 'vitest';
import type {DashboardNotification} from '@/api/dashboard-api';
import type {NotificationInboxItem} from '@/domain/notifications/inbox';
import {notificationRowsForTab} from './notification-tabs';
import {NotificationRow} from './notifications-page';

const pageSource = readFileSync(new URL('./notifications-page.tsx', import.meta.url), 'utf8');
const tabsSource = readFileSync(new URL('./notification-tabs.ts', import.meta.url), 'utf8');

const mobileNotification: DashboardNotification = {
    id: 'cf7e8982-b6aa-418d-8e79-3ac8232b8653',
    kind: 'laundry',
    title: '세탁 완료',
    body: '세탁물을 꺼내 주세요.',
    path: '/#/laundry',
    createdAtEpochMs: Date.parse('2026-08-11T02:00:00.000Z'),
    expiresAtEpochMs: Date.parse('2026-08-12T02:00:00.000Z'),
    attempt: 1,
};

const desktopNotification: NotificationInboxItem = {
    id: '1',
    title: '출석 확인',
    body: '출석 상태를 확인해 주세요.',
    createdAt: Date.parse('2026-08-11T02:00:00.000Z'),
    readAt: null,
    action: 'openAttendance',
};

describe('notification row navigation semantics', () => {
    test('companion 알림 경로는 실제 링크로 렌더링한다', () => {
        const markup = renderToStaticMarkup(
            <NotificationRow
                item={mobileNotification}
                unread
                href={mobileNotification.path}
                onActivate={() => undefined}
                onDismiss={() => undefined}
            />,
        );

        expect(markup).toContain('<a');
        expect(markup).toContain('href="/#/laundry"');
        expect(markup).toContain('data-unread="true"');
        expect(markup).toContain('읽지 않은 알림');
        expect(markup).not.toContain('rounded-full');
        expect(markup).toContain('aria-label="본 알림으로 처리"');
        expect(markup).toContain('<button');
    });

    test('desktop 활성화 동작은 기존 버튼으로 유지한다', () => {
        const markup = renderToStaticMarkup(
            <NotificationRow
                item={desktopNotification}
                unread
                onActivate={() => undefined}
                onDismiss={() => undefined}
            />,
        );

        expect(markup).toContain('<button');
        expect(markup).not.toContain('<a ');
        expect((markup.match(/<button/g) ?? [])).toHaveLength(2);
    });

    test('이동하거나 실행할 동작이 없는 행은 article이다', () => {
        const markup = renderToStaticMarkup(
            <NotificationRow item={desktopNotification} unread={false}/>,
        );

        expect(markup).toContain('<article');
        expect(markup).not.toContain('<button');
        expect(markup).not.toContain('<a ');
    });
});

describe('notification tab filtering', () => {
    test('companion과 desktop 알림은 각각 seen ID와 readAt으로 새 목록에서 지난 목록으로 이동한다', () => {
        const readDesktop = {...desktopNotification, readAt: Date.parse('2026-08-11T03:00:00.000Z')};
        const rows = [mobileNotification, desktopNotification, readDesktop];

        expect(notificationRowsForTab(rows, new Set(), 'new')).toEqual([mobileNotification, desktopNotification]);
        expect(notificationRowsForTab(rows, new Set([mobileNotification.id]), 'new')).toEqual([desktopNotification]);
        expect(notificationRowsForTab(rows, new Set([mobileNotification.id]), 'history')).toEqual([
            mobileNotification,
            readDesktop,
        ]);
    });
});

describe('notification center information architecture', () => {
    test('새 알림과 지난 알림을 의미론적 탭으로 구분한다', () => {
        expect(pageSource).toContain('export function NotificationPanelContent');
        expect(pageSource).toContain('aria-labelledby="notification-inbox-title"');
        expect(pageSource).toContain('id="notification-inbox-title">받은 알림</h2>');
        expect(pageSource).toContain('aria-labelledby="notification-delivery-title"');
        expect(pageSource).toContain('id="notification-delivery-title">알림 수신</h2>');
        expect(pageSource).toContain('<Tabs defaultValue="new"');
        expect(pageSource).toContain('<TabsTrigger value="new">새 알림</TabsTrigger>');
        expect(pageSource).toContain('<TabsTrigger value="history">지난 알림</TabsTrigger>');
        expect(tabsSource).toContain("'createdAtEpochMs' in item ? seenMobileIds.has(item.id) : item.readAt !== null");
        expect(tabsSource).toContain('seenMobileIds.has(item.id)');
        expect(pageSource).toContain('onMobileNotificationsSeen([item.id])');
    });

    test('새 알림이 있을 때만 전체 읽음 동작을 제공한다', () => {
        expect(pageSource).toContain('markAllDesktopNotificationsRead');
        expect(pageSource).toContain('markAllNotificationInboxItemsRead');
        expect(pageSource).toContain('onMobileNotificationsSeen(mobileIds)');
        expect(pageSource).toContain('모두 읽음');
        expect(pageSource).toContain('newRows.length > 0');
    });

    test('캐시된 알림은 백그라운드 재조회 실패 시에도 유지한다', () => {
        expect(pageSource).toContain('notifications.isError && !notifications.data');
        expect(pageSource).toContain('최신 알림을 확인하지 못했습니다.');
        expect(pageSource).toContain('마지막으로 확인한 알림을 표시합니다.');
    });

    test('새 푸시 연결이나 테스트를 시작할 때 이전 성공 문구를 지운다', () => {
        expect(pageSource.match(/setDeliveryMessage\(''\)/gu)).toHaveLength(2);
        expect(pageSource).toContain('setShowSystemSettingsShortcut(false)');
    });

    test('서비스 워커와 공개 키를 미리 준비하고 구독을 클릭 핸들러에서 시작한다', () => {
        expect(pageSource).toContain('platform.pwa.preparePush()');
        expect(pageSource).toContain('push.mutate(platform.pwa.subscribePush(pushSetup.data));');
        expect(pageSource).toContain('testNotification.mutate(platform.pwa.subscribePush(pushSetup.data));');
        expect(pageSource).not.toContain('subscribePush(await api.getPushPublicKey())');
    });

    test('테스트 Push는 Worker 전달 주기를 사용자에게 명확히 안내한다', () => {
        expect(pageSource).toContain('테스트 푸시를 전송 대기열에 추가했습니다. 1분 안에 도착합니다.');
    });

    test('PC 테스트 알림의 OS 표시 실패 경고에서 알림 설정을 바로 연다', () => {
        expect(pageSource).toContain('setShowSystemSettingsShortcut(!result.systemDelivered)');
        expect(pageSource).toContain('운영체제 알림을 표시하지 못했습니다.');
        expect(pageSource).toContain('<SystemNotificationSettingsButton/>');
    });

    test('패널에서는 중복 제목 없이 기존 알림 처리 UI를 재사용한다', () => {
        expect(pageSource).toContain('export function NotificationPanelContent');
        expect(pageSource).not.toContain('export function NotificationsPage');
        expect(pageSource).not.toContain('<PageHeader');
    });
});
