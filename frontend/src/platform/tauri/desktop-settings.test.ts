import {describe, expect, test, vi} from 'vitest';
import {createNativeBridge} from './native-bridge';
import {createDashboardDesktopSettingsApi} from './desktop-settings';

describe('desktop update adapter', () => {
    test('parses the exact update status and installs through the native bridge', async () => {
        const invoke = vi.fn(async (command: string) => {
            if (command === 'check_desktop_update') {
                return {currentVersion: '0.5.0', availableVersion: '0.5.1'};
            }
            return null;
        });
        const api = createDashboardDesktopSettingsApi(createNativeBridge(invoke));

        await expect(api.checkDesktopUpdate()).resolves.toEqual({
            currentVersion: '0.5.0',
            availableVersion: '0.5.1',
        });
        await expect(api.installDesktopUpdate()).resolves.toBeUndefined();
        await expect(api.openSystemNotificationSettings()).resolves.toBeUndefined();
        expect(invoke.mock.calls).toEqual([
            ['check_desktop_update'],
            ['install_desktop_update'],
            ['open_system_notification_settings'],
        ]);
    });

    test.each([
        {currentVersion: '0.5.0'},
        {currentVersion: '0.5.0', availableVersion: 'latest'},
        {currentVersion: '0.5.0', availableVersion: null, extra: true},
    ])('rejects malformed update status %#', async (value) => {
        const api = createDashboardDesktopSettingsApi(createNativeBridge(async () => value));
        await expect(api.checkDesktopUpdate()).rejects.toThrow('API_RESPONSE_INVALID');
    });
});
