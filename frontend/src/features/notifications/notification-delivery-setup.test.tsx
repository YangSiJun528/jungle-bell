import {readFileSync} from 'node:fs';

import {describe, expect, test} from 'vitest';

const source = readFileSync(new URL('./notification-delivery-setup.tsx', import.meta.url), 'utf8');

describe('notification delivery setup', () => {
    test('알림 패널과 선택형 온보딩이 같은 전달 점검 로직을 사용한다', () => {
        expect(source).toContain('export function NotificationDeliverySection');
        expect(source).toContain('export function NotificationOnboardingCard');
        expect(source).toContain('api.sendDesktopTestNotification()');
        expect(source).toContain('api.sendMobileTestNotification()');
        expect(source).toContain('api.registerPushSubscription(subscription)');
    });

    test('브라우저 권한 요청은 클릭의 사용자 활성화 안에서 시작한다', () => {
        expect(source).toContain('platform.pwa.preparePush()');
        expect(source).toContain('push.mutate(platform.pwa.subscribePush(pushSetup.data));');
        expect(source).toContain(
            'testNotification.mutate(platform.pwa.subscribePush(pushSetup.data));',
        );
        expect(source).not.toContain('subscribePush(await api.getPushPublicKey())');
    });

    test('모바일은 전송 대기열 등록과 실제 도착 확인을 구분하고 언제든 건너뛸 수 있다', () => {
        expect(source).toContain('알림 연결하고 테스트');
        expect(source).toContain('1분 안에 도착합니다.');
        expect(source).toContain('테스트 알림이 실제로 도착했나요?');
        expect(source).toContain('도착했어요');
        expect(source).toContain('도착하지 않았어요');
        expect(source).toContain('나중에');
    });

    test('푸시 준비 자체가 실패해도 사용자가 바로 다시 시도할 수 있다', () => {
        expect(source).toContain('pushSetup.refetch()');
        expect(source).toContain('푸시 다시 준비');
    });

    test('PC 운영체제 표시 실패 시 시스템 알림 설정 경로를 제공한다', () => {
        expect(source).toContain('setShowSystemSettingsShortcut(!result.systemDelivered)');
        expect(source).toContain('운영체제 알림을 표시하지 못했습니다.');
        expect(source).toContain('<SystemNotificationSettingsButton />');
    });
});
