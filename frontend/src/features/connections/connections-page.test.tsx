import {readFileSync} from 'node:fs';

import {describe, expect, test} from 'vitest';

const source = readFileSync(new URL('./connections-page.tsx', import.meta.url), 'utf8');
const disconnectFeedbackSource = readFileSync(
    new URL('./companion-disconnect-feedback.tsx', import.meta.url),
    'utf8',
);
const notificationSettingsSource = readFileSync(
    new URL('../../app/settings/notification-settings.tsx', import.meta.url),
    'utf8',
);

describe('ConnectionsPage settings information architecture', () => {
    test('설정 제목 아래에 앱 상태, 알림, 서비스, 기기 연결 탭을 둔다', () => {
        expect(source.match(/<PageHeader title="설정" \/>/gu)).toHaveLength(1);
        expect(source).toContain('value={selectedTab}');
        expect(source).toContain('onValueChange={selectTab}');
        expect(source).toContain('renderAppStatus ? (');
        expect(source).toContain('<TabsTrigger value="status">앱 상태</TabsTrigger>');
        expect(source).toContain('<TabsTrigger value="notifications">알림</TabsTrigger>');
        expect(source).toContain('<TabsTrigger value="services">서비스</TabsTrigger>');
        expect(source).toContain('<TabsTrigger value="devices">기기 연결</TabsTrigger>');
        expect(source).toContain('<TabsContent value="notifications"');
        expect(source).toContain('<NotificationSettings />');
        expect(notificationSettingsSource).toContain('<AttendancePreferencesSection />');
        expect(notificationSettingsSource).toContain('<MealPreferencesSection />');
        expect(source).toContain('<TabsContent value="services"');
        expect(source).toContain('<ServiceSettings />');
        expect(source).toContain('<TabsContent value="status"');
        expect(source).toContain('{renderAppStatus()}');
        expect(source).not.toContain('앱 상태 연결 필요');
    });

    test('다른 feature를 직접 가져오지 않고 선택형 앱 상태 slot을 노출한다', () => {
        expect(source).not.toMatch(/from ['"]\.\.\/(?:app-status|notifications)\//u);
    });

    test('기기 연결 기능은 보존하고 데스크톱 로컬 설정은 서비스 탭에만 둔다', () => {
        expect(source).toContain('platform.capabilities.mobilePairingManagement');
        expect(source).toContain("platform.accountAuthentication.kind === 'cookie'");
        expect(source).toContain('<WebConnections />');
        expect(source).toContain('api.createMobilePairing()');
        expect(source).toContain('api.claimManualPairing');
        expect(source).toContain('api.disconnectMobileSession()');
        expect(source).not.toContain('api.getDesktopSettings()');
        expect(source).not.toContain('api.updateDesktopSettings(');
        expect(source).not.toContain('로그인 시 자동 시작');
    });

    test('PC 초기화는 명시적인 확인 다이얼로그의 동의 동작에서만 실행한다', () => {
        expect(source).toContain("setIdentityResetReason('reset')");
        expect(source).toContain('PC 연결 정보를 초기화할까요?');
        expect(source).toContain('네, PC 초기화');
        expect(source).toContain('이 PC의 서버 계정과 인증 정보를 삭제하고 새로 만듭니다.');
        expect(source).toContain('기존 identity를 복원하는 별도');
        expect(source).toContain('onClick={() => reset.mutate()}');
        expect(source).not.toContain('window.confirm');
    });

    test('identity 복구는 비파괴 재확인, 초기화는 별도 파괴 동작으로 구분한다', () => {
        expect(source).toContain('안전한 PC identity 복구는 현재 앱 계약에서 지원하지 않습니다.');
        expect(source).toContain('복구 기능 준비 안 됨');
        expect(source).toContain("setIdentityResetReason('reset')");
        expect(source).toContain('reset.mutate()');
        expect(source).toContain('네, PC 초기화');
        expect(source).toContain("value.state !== 'connected'");
        expect(source).not.toContain('recover.mutate()');
    });

    test('PC와 현재 모바일 연결 해제 모두 확인, 중복 방지, 성공과 실패 피드백을 제공한다', () => {
        expect(source).toContain('연결을 해제할까요?');
        expect(source).toContain('해제하면 이 기기의 출석과 개인 알림을 사용할 수 없습니다.');
        expect(source).toContain('연결 해제 완료');
        expect(source).toContain('연결 해제 실패');
        expect(source).toContain('disconnectInFlight.current');
        expect(source).toContain('revokeInFlight.current');
        expect(source.match(/event\.preventDefault\(\)/gu)).toHaveLength(2);
        expect(source).toContain('setDisconnectFeedback(result)');
    });

    test('현재 모바일은 인증을 없애기 전에 서버와 동일한 로컬 푸시를 순서대로 정리한다', () => {
        expect(source).toContain('disconnectCompanionWithPushCleanup({');
        expect(source).toContain('cleanupPushSubscription({');
        expect(source).toContain('api.unregisterPushSubscription(subscriptionId)');
        expect(source).toContain('platform.pwa.unsubscribePush(subscription.endpoint)');
        expect(source).toContain('disconnectSession: () => api.disconnectMobileSession()');
        expect(disconnectFeedbackSource).toContain('연결 해제 완료 · 푸시 정리 미확인');
        expect(disconnectFeedbackSource).toContain(
            '다시 시도할 때 완료한 정리는 반복하지 않습니다.',
        );
        expect(source).toContain('previousCleanup: completedPushCleanup.current');
    });

    test('양쪽 pairing 대기에 취소, 코드 변경, 만료 후 재생성, 재시작 복구를 제공한다', () => {
        expect(source).toContain('연결 대기 취소');
        expect(source).toContain('새 QR과 코드 만들기');
        expect(source).toContain('코드 변경');
        expect(source).toContain('window.localStorage');
        expect(source).toContain('다시 연결');
        expect(source).toContain('서버 만료 시 더 일찍 끝날 수 있습니다.');
    });

    test('작은 PC 창에서도 QR 옆 승인 영역과 버튼이 카드 안에서 줄어든다', () => {
        expect(source).toContain('휴대폰 설정');
        expect(source).toContain('스캔하면 PC 연결, 앱 설치, 알림 설정을 순서대로 안내합니다.');
        expect(source).toContain('alt="휴대폰 설정 시작 QR 코드"');
        expect(source).toContain('sm:grid-cols-[9rem_minmax(0,1fr)]');
        expect(source).toContain('className="min-w-0 space-y-3"');
        expect(source).toMatch(
            /<Alert>[\s\S]*?<AlertDescription[^>]*>[\s\S]*?확인 번호[\s\S]*?<Button[^>]*>[\s\S]*?이 휴대폰 승인[\s\S]*?<\/Button>[\s\S]*?<\/AlertDescription>[\s\S]*?<\/Alert>/u,
        );
    });
});
