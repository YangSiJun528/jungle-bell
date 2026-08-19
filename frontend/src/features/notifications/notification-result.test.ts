import {describe, expect, test} from 'vitest';
import type {DesktopTestNotificationResult} from '@/api/dashboard-api';
import {desktopTestNotificationMessage, mobilePushErrorMessage} from './notification-result';

const result = (systemDelivered: boolean, mobileQueued: number | null): DesktopTestNotificationResult => ({
    snapshot: {revision: 0, unreadCount: 0, items: []},
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

describe('mobile push error result', () => {
    test('권한·지원·서버 설정 오류를 구분한다', () => {
        expect(mobilePushErrorMessage(new Error('PUSH_PERMISSION_DENIED'))).toContain('알림을 허용');
        expect(mobilePushErrorMessage(new DOMException('', 'NotAllowedError'))).toContain('알림을 허용');
        expect(mobilePushErrorMessage(new Error('PUSH_UNSUPPORTED'))).toContain('Web Push를 지원');
        expect(mobilePushErrorMessage(new Error('PUSH_NOT_READY'))).toContain('준비가 끝나지 않았습니다');
        expect(mobilePushErrorMessage(new Error('WEB_PUSH_NOT_CONFIGURED'))).toContain('서버의 Web Push 설정');
    });

    test('알 수 없는 오류는 재시도 안내를 한다', () => {
        expect(mobilePushErrorMessage(new Error('NETWORK_ERROR'))).toContain('다시 시도');
    });
});
