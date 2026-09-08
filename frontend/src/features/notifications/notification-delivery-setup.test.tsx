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
        expect(source).not.toContain('1분 안에 도착합니다.');
        expect(source).toContain('최대 1분 정도 걸릴 수 있습니다.');
        expect(source).toContain('테스트 알림이 실제로 도착했나요?');
        expect(source).toContain('도착했어요');
        expect(source).toContain('도착하지 않았어요');
        expect(source).toContain('나중에');
    });

    test('권한, 로컬 구독, 서버 등록, 테스트 발송, 실제 도착을 단계별로 표시한다', () => {
        for (const label of [
            '알림 권한',
            '로컬 푸시 구독',
            '서버 등록',
            '테스트 발송',
            '실제 도착 확인',
        ]) {
            expect(source).toContain(label);
        }
        expect(source).toContain('pushDeliveryStepStates');
        expect(source).toContain('assertMobileTestNotificationQueued');
    });

    test('미도착 복구의 다시 보내기는 실제 테스트 API를 다시 실행하고 재등록도 제공한다', () => {
        expect(source).toContain('onClick={delivery.sendTestNotification}');
        expect(source).toContain('테스트 다시 보내기');
        expect(source).toContain('onClick={delivery.reregisterPush}');
        expect(source).toContain('푸시 재등록');
        expect(source).toContain('집중 모드');
    });

    test('푸시 끄기는 서버를 먼저 해제하고 같은 로컬 구독만 제거한다', () => {
        expect(source).toContain('푸시 끄기');
        expect(source).toContain('cleanupPushSubscription({');
        expect(source).toContain('api.unregisterPushSubscription(subscriptionId)');
        expect(source).toContain('platform.pwa.getPushSubscription()');
        expect(source).toContain('platform.pwa.unsubscribePush(subscription.endpoint)');
        expect(source).toContain(
            '서버 등록을 먼저 해제한 뒤 같은 로컬 구독인지 다시 확인하고 제거합니다.',
        );
        expect(source).toContain('푸시 끄기 다시 시도');
        expect(source).not.toMatch(/<Button[^>]*disabled[^>]*>\s*푸시 끄기/u);
    });

    test('재시작 때 저장 메타데이터와 실제 로컬 구독을 대조해 상태를 복구한다', () => {
        expect(source).toContain('loadPushSubscriptionReconciliation({');
        expect(source).toContain('restoredPushDeliveryState(');
        expect(source).toContain('이번 서버 등록 응답과 일치합니다.');
        expect(source).toContain('현재 서버 등록은 확인되지 않았습니다.');
        expect(source).toContain("serverEvidence: 'registration-response'");
        expect(source).toContain('서버 등록 ID가 없어 푸시 정리 완료로 확인하지 않았습니다.');
        expect(source).toContain('PUSH_SUBSCRIPTION_LIFECYCLE_QUERY_KEY');
        expect(source).toContain('notificationPermissionFromRuntime');
    });

    test('테스트 발송과 실제 도착 결과를 App Status와 같은 canonical 기록으로 공유한다', () => {
        expect(source).toContain('writeNotificationTestRecord');
        expect(source).toContain('NOTIFICATION_TEST_QUERY_KEY');
        expect(source).toContain("status: 'test-sending'");
        expect(source).toContain("status: 'arrived'");
        expect(source).toContain("status: 'not-arrived'");
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

    test('PC 운영체제 호출 성공도 사용자가 실제 표시를 확인해야 완료한다', () => {
        expect(source).toContain(
            "setDesktopArrival(result.systemDelivered ? 'confirming' : 'missing')",
        );
        expect(source).not.toContain('setDesktopDeliveryConfirmed(result.systemDelivered)');
        expect(source).toContain('PC 테스트 알림이 실제로 보였나요?');
        expect(source).toContain('보였어요');
        expect(source).toContain('보이지 않았어요');
    });
});
