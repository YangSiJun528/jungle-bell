import {describe, expect, test, vi} from 'vitest';

import type {NativeInvoke} from '@/platform/contracts';

import {createDashboardDesktopSettingsApi} from './desktop-settings';
import {createNativeBridge} from './native-bridge';

const desktopSettings = {
    appVersion: '0.5.0',
    autoStart: true,
    usageAnalytics: false,
    usageAnalyticsSyncPending: false,
    debugMode: false,
    selectedCohortId: null,
    effectiveCohortId: null,
    cohortOptions: [],
};

describe('desktop settings adapter', () => {
    test('autoUpdate 없는 exact 설정을 파싱하고 exact update input만 전송한다', async () => {
        const invoke = vi.fn<NativeInvoke>(async (command) =>
            command === 'update_desktop_settings'
                ? {...desktopSettings, autoStart: false}
                : desktopSettings,
        );
        const api = createDashboardDesktopSettingsApi(createNativeBridge(invoke));

        await expect(api.getDesktopSettings()).resolves.toEqual(desktopSettings);
        await expect(
            api.updateDesktopSettings({
                autoStart: false,
                usageAnalytics: false,
                debugMode: false,
                selectedCohortId: null,
            }),
        ).resolves.toEqual({...desktopSettings, autoStart: false});
        expect(invoke.mock.calls).toEqual([
            ['get_desktop_settings'],
            [
                'update_desktop_settings',
                {
                    input: {
                        autoStart: false,
                        usageAnalytics: false,
                        debugMode: false,
                        selectedCohortId: null,
                    },
                },
            ],
        ]);
    });

    test('예전 autoUpdate 필드가 남은 설정 응답을 거부한다', async () => {
        const api = createDashboardDesktopSettingsApi(
            createNativeBridge(async () => ({...desktopSettings, autoUpdate: true})),
        );

        await expect(api.getDesktopSettings()).rejects.toThrow('API_RESPONSE_INVALID');
    });
});

describe('desktop update adapter', () => {
    test('단계와 policy, 진행률을 포함한 exact 상태를 파싱하고 native 설치를 호출한다', async () => {
        const updateStatus = {
            currentVersion: '0.5.0',
            availableVersion: '0.6.0',
            status: 'downloading',
            policy: 'mandatory',
            progress: {downloadedBytes: 25, totalBytes: 100},
            errorCode: null,
        };
        const invoke = vi.fn<NativeInvoke>(async (command) => {
            if (command === 'check_desktop_update') return updateStatus;
            return null;
        });
        const api = createDashboardDesktopSettingsApi(createNativeBridge(invoke));

        await expect(api.checkDesktopUpdate()).resolves.toEqual(updateStatus);
        await expect(api.installDesktopUpdate()).resolves.toBeUndefined();
        await expect(api.openSystemNotificationSettings()).resolves.toBeUndefined();
        expect(invoke.mock.calls).toEqual([
            ['check_desktop_update'],
            ['install_desktop_update'],
            ['open_system_notification_settings'],
        ]);
    });

    test.each([
        {
            currentVersion: '0.6.0',
            availableVersion: null,
            status: 'latest',
            policy: null,
            progress: null,
            errorCode: null,
        },
        {
            currentVersion: '0.5.0',
            availableVersion: '0.5.1',
            status: 'optional',
            policy: 'optional',
            progress: null,
            errorCode: null,
        },
        {
            currentVersion: '0.5.0',
            availableVersion: '0.6.0',
            status: 'mandatory',
            policy: 'mandatory',
            progress: null,
            errorCode: null,
        },
        {
            currentVersion: '0.5.0',
            availableVersion: '0.6.0',
            status: 'failed',
            policy: 'mandatory',
            progress: {downloadedBytes: 10, totalBytes: null},
            errorCode: 'UPDATE_VERIFY_FAILED',
        },
    ])('상태 조합을 손실 없이 파싱한다: $status', async (value) => {
        const api = createDashboardDesktopSettingsApi(createNativeBridge(async () => value));
        await expect(api.checkDesktopUpdate()).resolves.toEqual(value);
    });

    test.each([
        {
            currentVersion: '0.5.0',
            availableVersion: null,
            status: 'latest',
            policy: null,
            progress: null,
        },
        {
            currentVersion: '0.5.0',
            availableVersion: 'latest',
            status: 'mandatory',
            policy: 'mandatory',
            progress: null,
            errorCode: null,
        },
        {
            currentVersion: '0.5.0',
            availableVersion: null,
            status: 'latest',
            policy: null,
            progress: null,
            errorCode: null,
            extra: true,
        },
        {
            currentVersion: '0.5.0',
            availableVersion: '0.6.0',
            status: 'mandatory',
            policy: 'optional',
            progress: null,
            errorCode: null,
        },
        {
            currentVersion: '0.5.0',
            availableVersion: null,
            status: 'mandatory',
            policy: 'mandatory',
            progress: null,
            errorCode: null,
        },
        {
            currentVersion: '0.5.0',
            availableVersion: '0.6.0',
            status: 'downloading',
            policy: 'mandatory',
            progress: {downloadedBytes: 101, totalBytes: 100},
            errorCode: null,
        },
        {
            currentVersion: '0.5.0',
            availableVersion: '0.6.0',
            status: 'failed',
            policy: 'mandatory',
            progress: null,
            errorCode: null,
        },
        {
            currentVersion: '0.5.0',
            availableVersion: '0.6.0',
            status: 'mandatory',
            policy: 'mandatory',
            progress: null,
            errorCode: null,
            mandatory: true,
        },
    ])('rejects malformed update status %#', async (value) => {
        const api = createDashboardDesktopSettingsApi(createNativeBridge(async () => value));
        await expect(api.checkDesktopUpdate()).rejects.toThrow('API_RESPONSE_INVALID');
    });
});
