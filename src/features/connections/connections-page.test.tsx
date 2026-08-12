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
        expect(source).toContain('<NotificationSettings surface={personalSurface}/>');
        expect(notificationSettingsSource).toContain('<AttendancePreferencesSection surface={surface}/>');
        expect(notificationSettingsSource).toContain('<MealPreferencesSection surface={surface}/>');
        expect(source).toContain('<TabsContent value="services"');
        expect(source).toContain('<ServiceSettings/>');
    });

    test('기기 연결 기능은 보존하고 데스크톱 로컬 설정은 서비스 탭에만 둔다', () => {
        expect(source).toContain("surface.kind === 'desktop' ? <DesktopConnections/> : <CompanionConnections/>");
        expect(source).toContain('api.createMobilePairing()');
        expect(source).toContain('api.claimManualPairing');
        expect(source).toContain('api.disconnectMobileSession()');
        expect(source).not.toContain('api.getDesktopSettings()');
        expect(source).not.toContain('api.updateDesktopSettings(');
        expect(source).not.toContain('로그인 시 자동 시작');
    });
});
