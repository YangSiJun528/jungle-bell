import {describe, expect, it, vi} from 'vitest';
import type {NativeBridge, PwaCapabilityAdapter} from './contracts';
import {
    PlatformCapabilityUnavailableError,
    unavailableEventAdapter,
} from './contracts';
import {createTauriPlatformAdapter} from './tauri/adapter';
import {createWebPlatformAdapter} from './web/adapter';

function nativeBridge(): NativeBridge {
    return {
        bootstrapDesktopHttpSession: vi.fn(async () => ({
            accessToken: `jbui_${'a'.repeat(64)}`,
            expiresAt: '2026-08-13T12:00:00.000Z',
        })),
        getDesktopSettings: vi.fn(),
        updateDesktopSettings: vi.fn(),
        openLogFolder: vi.fn(),
        getDesktopConnectionState: vi.fn(),
        resetDesktopIdentity: vi.fn(),
        refreshPlatformSync: vi.fn(),
        openLmsLogin: vi.fn(),
        getNotificationInboxSnapshot: vi.fn(),
        markNotificationRead: vi.fn(),
        activateNotification: vi.fn(),
        sendTestNotification: vi.fn(),
    };
}

function pwaAdapter(installed: boolean): PwaCapabilityAdapter {
    return {
        available: true,
        installed,
        registerServiceWorker: vi.fn(),
        subscribeInstallPrompt: vi.fn(() => () => undefined),
        isMobileInstallClient: vi.fn(() => false),
        subscribePush: vi.fn(),
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
            lmsWindow: true,
            mobilePairingManagement: true,
            pwaInstall: false,
            webPush: false,
        });
    });
});
