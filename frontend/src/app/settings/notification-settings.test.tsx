import {readFileSync} from 'node:fs';

import {describe, expect, test} from 'vitest';

const settingsSource = readFileSync(
    new URL('./notification-settings.tsx', import.meta.url),
    'utf8',
);

describe('notification settings', () => {
    test('알림 설정의 마지막에 운영체제 알림 설정 바로가기를 제공한다', () => {
        expect(settingsSource).toContain('<MealPreferencesSection />');
        expect(settingsSource).toContain('<SystemNotificationSettingsCard />');
        expect(settingsSource.indexOf('<SystemNotificationSettingsCard />')).toBeGreaterThan(
            settingsSource.indexOf('<MealPreferencesSection />'),
        );
    });

    test('같은 레벨의 설정 카드는 서비스 설정과 같은 간격을 사용한다', () => {
        expect(settingsSource).toContain('<div className="space-y-4">');
        expect(settingsSource).not.toContain('space-y-6');
    });
});
