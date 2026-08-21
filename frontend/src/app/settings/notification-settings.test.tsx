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
});
