import {describe, expect, it, vi} from 'vitest';
import type {NativeBridge} from '@/api/native-bridge';
import {
    createPlatformAdapter,
    PlatformCapabilityUnavailableError,
} from './platform-adapter';

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

describe('PlatformAdapter', () => {
    it('브라우저에서는 공통 SPA를 사용하고 네이티브 기능을 지원하지 않는다', async () => {
        const platform = createPlatformAdapter({runningInTauri: false});

        expect(platform.kind).toBe('browser');
        expect(platform.accountAuthentication.kind).toBe('cookie');
        expect(platform.capabilities).toEqual({
            desktopAccount: false,
            desktopSettings: false,
            localNotifications: false,
            lmsWindow: false,
            mobilePairingManagement: false,
        });
        await expect(platform.native.openLmsLogin()).rejects.toEqual(
            new PlatformCapabilityUnavailableError('lmsWindow'),
        );
    });

    it('Tauri에서는 같은 SPA에 데스크톱 기능과 단기 HTTP 세션을 주입한다', () => {
        const native = nativeBridge();
        const platform = createPlatformAdapter({runningInTauri: true, nativeBridge: native});

        expect(platform.kind).toBe('desktop');
        expect(platform.native).toBe(native);
        expect(platform.accountAuthentication).toEqual({kind: 'desktop-session'});
        expect(Object.values(platform.capabilities).every(Boolean)).toBe(true);
    });
});
