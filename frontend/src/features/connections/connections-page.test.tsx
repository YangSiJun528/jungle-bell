import {readFileSync} from 'node:fs';
import {describe, expect, test} from 'vitest';

const source = readFileSync(new URL('./connections-page.tsx', import.meta.url), 'utf8');
const notificationSettingsSource = readFileSync(
    new URL('../../app/settings/notification-settings.tsx', import.meta.url),
    'utf8',
);

describe('ConnectionsPage settings information architecture', () => {
    test('설정 제목 아래에 알림, 서비스, 기기 연결 탭을 둔다', () => {
        expect(source.match(/<PageHeader title="설정"\/>/gu)).toHaveLength(1);
        expect(source).toContain('<Tabs defaultValue="notifications"');
        expect(source).toContain('<TabsTrigger value="notifications">알림</TabsTrigger>');
        expect(source).toContain('<TabsTrigger value="services">서비스</TabsTrigger>');
        expect(source).toContain('<TabsTrigger value="devices">기기 연결</TabsTrigger>');
        expect(source).toContain('<TabsContent value="notifications"');
        expect(source).toContain('<NotificationSettings/>');
        expect(notificationSettingsSource).toContain('<AttendancePreferencesSection/>');
        expect(notificationSettingsSource).toContain('<MealPreferencesSection/>');
        expect(source).toContain('<TabsContent value="services"');
        expect(source).toContain('<ServiceSettings/>');
    });

    test('기기 연결 기능은 보존하고 데스크톱 로컬 설정은 서비스 탭에만 둔다', () => {
        expect(source).toContain('platform.capabilities.mobilePairingManagement');
        expect(source).toContain("platform.accountAuthentication.kind === 'cookie'");
        expect(source).toContain('<WebConnections/>');
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
        expect(source).toContain('기존 모바일 정리는 운영자 확인이 필요할 수 있습니다.');
        expect(source).toContain('onClick={() => reset.mutate()}');
        expect(source).not.toContain('window.confirm');
    });
});
