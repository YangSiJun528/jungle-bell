import {describe, expect, test, vi} from 'vitest';

import type {NativeInvoke} from '@/platform/contracts';

import {createDashboardDesktopSettingsApi} from './desktop-settings';
import {createNativeBridge} from './native-bridge';

describe('desktop update adapter', () => {
    test('parses the exact update status and installs through the native bridge', async () => {
        const invoke = vi.fn<NativeInvoke>(async (command) => {
            if (command === 'check_desktop_update') {
                return {currentVersion: '0.5.0', availableVersion: '0.6.0', mandatory: true};
            }
            return null;
        });
        const api = createDashboardDesktopSettingsApi(createNativeBridge(invoke));

        await expect(api.checkDesktopUpdate()).resolves.toEqual({
            currentVersion: '0.5.0',
            availableVersion: '0.6.0',
            mandatory: true,
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
        {currentVersion: '0.5.0', availableVersion: null},
        {currentVersion: '0.5.0', availableVersion: 'latest', mandatory: false},
        {currentVersion: '0.5.0', availableVersion: null, mandatory: false, extra: true},
        {currentVersion: '0.5.0', availableVersion: null, mandatory: 'false'},
        {currentVersion: '0.5.0', availableVersion: null, mandatory: true},
    ])('rejects malformed update status %#', async (value) => {
        const api = createDashboardDesktopSettingsApi(createNativeBridge(async () => value));
        await expect(api.checkDesktopUpdate()).rejects.toThrow('API_RESPONSE_INVALID');
    });
});
