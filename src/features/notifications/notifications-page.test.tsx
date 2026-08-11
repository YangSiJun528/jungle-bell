import {readFileSync} from 'node:fs';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, test} from 'vitest';
import type {DashboardNotification} from '@/dashboard-api';
import type {NotificationInboxItem} from '@/notification-inbox';
import {NotificationRow} from './notifications-page';

const pageSource = readFileSync(new URL('./notifications-page.tsx', import.meta.url), 'utf8');

const mobileNotification: DashboardNotification = {
    id: 'cf7e8982-b6aa-418d-8e79-3ac8232b8653',
    kind: 'laundry',
    title: '세탁 완료',
    body: '세탁물을 꺼내 주세요.',
    path: '/dashboard.html#laundry',
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
            <NotificationRow item={mobileNotification} unread href={mobileNotification.path}/>,
        );

        expect(markup).toContain('<a');
        expect(markup).toContain('href="/dashboard.html#laundry"');
        expect(markup).toContain('data-unread="true"');
        expect(markup).toContain('읽지 않은 알림');
        expect(markup).not.toContain('rounded-full');
        expect(markup).not.toContain('<button');
    });

    test('desktop 활성화 동작은 기존 버튼으로 유지한다', () => {
        const markup = renderToStaticMarkup(
            <NotificationRow item={desktopNotification} unread onOpen={() => undefined}/>,
        );

        expect(markup).toContain('<button');
        expect(markup).not.toContain('<a ');
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

describe('notification center information architecture', () => {
    test('알림 기록과 수신 제어를 탭 없이 별도 섹션으로 구분한다', () => {
        expect(pageSource).toContain('<PageHeader title="알림 센터"/>');
        expect(pageSource).toContain('aria-labelledby="notification-inbox-title"');
        expect(pageSource).toContain('id="notification-inbox-title">받은 알림</h2>');
        expect(pageSource).toContain('aria-labelledby="notification-delivery-title"');
        expect(pageSource).toContain('id="notification-delivery-title">알림 수신</h2>');
        expect(pageSource).not.toMatch(/<Tabs\b|role="tab(?:list)?"/u);
    });

    test('캐시된 알림은 백그라운드 재조회 실패 시에도 유지한다', () => {
        expect(pageSource).toContain('notifications.isError && !notifications.data');
        expect(pageSource).toContain('최신 알림을 확인하지 못했습니다.');
        expect(pageSource).toContain('마지막으로 확인한 알림을 표시합니다.');
    });

    test('새 푸시 연결이나 테스트를 시작할 때 이전 성공 문구를 지운다', () => {
        expect(pageSource.match(/onMutate: \(\) => setDeliveryMessage\(''\)/gu)).toHaveLength(2);
    });
});
