import {describe, expect, it, vi} from 'vitest';

import type {NativeBridge, PwaCapabilityAdapter} from './contracts';
import {PlatformCapabilityUnavailableError, unavailableEventAdapter} from './contracts';
import {createTauriPlatformAdapter} from './tauri/adapter';
import {createWebPlatformAdapter} from './web/adapter';

function nativeBridge(): NativeBridge {
    return {
        bootstrapDesktopHttpSession: vi.fn<NativeBridge['bootstrapDesktopHttpSession']>(
            async () => ({
                accessToken: `jbui_${'a'.repeat(64)}`,
                expiresAt: '2026-08-13T12:00:00.000Z',
            }),
        ),
        getDesktopSettings: vi.fn<NativeBridge['getDesktopSettings']>(),
        updateDesktopSettings: vi.fn<NativeBridge['updateDesktopSettings']>(),
        checkDesktopUpdate: vi.fn<NativeBridge['checkDesktopUpdate']>(),
        installDesktopUpdate: vi.fn<NativeBridge['installDesktopUpdate']>(),
        openLogFolder: vi.fn<NativeBridge['openLogFolder']>(),
        openSystemNotificationSettings: vi.fn<NativeBridge['openSystemNotificationSettings']>(),
        getDesktopConnectionState: vi.fn<NativeBridge['getDesktopConnectionState']>(),
        resetDesktopIdentity: vi.fn<NativeBridge['resetDesktopIdentity']>(),
        refreshPlatformSync: vi.fn<NativeBridge['refreshPlatformSync']>(),
        openLmsLogin: vi.fn<NativeBridge['openLmsLogin']>(),
        getNotificationInboxSnapshot: vi.fn<NativeBridge['getNotificationInboxSnapshot']>(),
        markNotificationRead: vi.fn<NativeBridge['markNotificationRead']>(),
        markAllNotificationsRead: vi.fn<NativeBridge['markAllNotificationsRead']>(),
        activateNotification: vi.fn<NativeBridge['activateNotification']>(),
        sendTestNotification: vi.fn<NativeBridge['sendTestNotification']>(),
    };
}

function pwaAdapter(installed: boolean): PwaCapabilityAdapter {
    return {
        available: true,
        installed,
        registerServiceWorker: vi.fn<PwaCapabilityAdapter['registerServiceWorker']>(),
        preparePush: vi.fn<PwaCapabilityAdapter['preparePush']>(async () => undefined),
        subscribeInstallPrompt: vi.fn<PwaCapabilityAdapter['subscribeInstallPrompt']>(
            () => () => undefined,
        ),
        isMobileInstallClient: vi.fn<PwaCapabilityAdapter['isMobileInstallClient']>(() => false),
        subscribePush: vi.fn<PwaCapabilityAdapter['subscribePush']>(),
    };
}

describe('PlatformAdapter', () => {
    it('일반 웹에서는 개인 인증과 Push를 주입하지 않는다', async () => {
        const platform = createWebPlatformAdapter(pwaAdapter(false));

        expect(platform.kind).toBe('browser');
        expect(platform.accountAuthentication.kind).toBe('none');
        expect(platform.capabilities).toEqual({
            desktopAccount: false,
            desktopSettings: false,
            localNotifications: false,
            laundryRiskIndicator: false,
            lmsWindow: false,
            mobilePairingManagement: false,
            pwaInstall: true,
            webPush: false,
        });
        await expect(platform.native.openLmsLogin()).rejects.toEqual(
            new PlatformCapabilityUnavailableError('lmsWindow'),
        );
    });

    it('설치형 PWA에서만 쿠키 인증과 Push를 주입한다', () => {
        const platform = createWebPlatformAdapter(pwaAdapter(true));

        expect(platform.accountAuthentication.kind).toBe('cookie');
        expect(platform.capabilities.webPush).toBe(true);
        expect(platform.capabilities.laundryRiskIndicator).toBe(true);
    });

    it('Tauri에서는 같은 SPA에 네이티브 기능과 메모리 단기 세션을 주입한다', () => {
        const native = nativeBridge();
        const platform = createTauriPlatformAdapter({
            nativeBridge: native,
            events: unavailableEventAdapter(),
        });

        expect(platform.kind).toBe('desktop');
        expect(platform.native).toBe(native);
        expect(platform.accountAuthentication.kind).toBe('desktop-session');
        expect(platform.capabilities).toEqual({
            desktopAccount: true,
            desktopSettings: true,
            localNotifications: true,
            laundryRiskIndicator: true,
            lmsWindow: true,
            mobilePairingManagement: true,
            pwaInstall: false,
            webPush: false,
        });
    });
});
