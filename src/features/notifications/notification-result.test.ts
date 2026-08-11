import {describe, expect, test} from 'vitest';
import type {DesktopTestNotificationResult} from '@/dashboard-api';
import {EMPTY_NOTIFICATION_INBOX} from '@/notification-inbox';
import {desktopTestNotificationMessage} from './notification-result';

const result = (systemDelivered: boolean, mobileQueued: number | null): DesktopTestNotificationResult => ({
    snapshot: EMPTY_NOTIFICATION_INBOX,
    systemDelivered,
    mobileQueued,
});

describe('desktop test notification result', () => {
    test('PC OS 알림 실패를 숨기지 않는다', () => {
        expect(desktopTestNotificationMessage(result(false, 0))).toContain('운영체제 알림을 표시하지 못했습니다');
        expect(desktopTestNotificationMessage(result(false, 2))).toContain('PC 운영체제 알림은 실패했습니다');
    });

    test('PC와 모바일 성공 범위를 구분한다', () => {
        expect(desktopTestNotificationMessage(result(true, 0))).toContain('연결된 모바일 푸시는 없습니다');
        expect(desktopTestNotificationMessage(result(true, 2))).toContain('모바일 2대');
    });
});
