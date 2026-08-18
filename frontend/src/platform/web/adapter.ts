import {
    type DesktopSettingsAdapter,
    type NativeBridge,
    type PlatformAdapter,
    PlatformCapabilityUnavailableError,
    type PlatformCapabilities,
    type PwaCapabilityAdapter,
    unavailableEventAdapter,
} from '@/platform/contracts';

const BASE_CAPABILITIES: PlatformCapabilities = {
    desktopAccount: false,
    desktopSettings: false,
    localNotifications: false,
    lmsWindow: false,
    mobilePairingManagement: false,
    pwaInstall: false,
    webPush: false,
};

export function createWebPlatformAdapter(pwa: PwaCapabilityAdapter): PlatformAdapter {
    const native = unsupportedNativeBridge();
    const installedPwa = pwa.available && pwa.installed;
    return {
        kind: 'browser',
        capabilities: {
            ...BASE_CAPABILITIES,
            pwaInstall: pwa.available,
            webPush: installedPwa,
        },
        accountAuthentication: installedPwa ? {kind: 'cookie'} : {kind: 'none'},
        native,
        desktopSettings: unsupportedDesktopSettings(),
        events: unavailableEventAdapter(),
        pwa,
    };
}

function unsupportedNativeBridge(): NativeBridge {
    const unsupported = (capability: keyof PlatformCapabilities) => async (): Promise<never> => {
        throw new PlatformCapabilityUnavailableError(capability);
    };
    return {
        bootstrapDesktopHttpSession: unsupported('desktopAccount'),
        getDesktopSettings: unsupported('desktopSettings'),
        updateDesktopSettings: unsupported('desktopSettings'),
        openLogFolder: unsupported('desktopSettings'),
        getDesktopConnectionState: unsupported('desktopAccount'),
        resetDesktopIdentity: unsupported('desktopAccount'),
        refreshPlatformSync: unsupported('desktopAccount'),
        openLmsLogin: unsupported('lmsWindow'),
        getNotificationInboxSnapshot: unsupported('localNotifications'),
        markNotificationRead: unsupported('localNotifications'),
        activateNotification: unsupported('localNotifications'),
        sendTestNotification: unsupported('localNotifications'),
    };
}

function unsupportedDesktopSettings(): DesktopSettingsAdapter {
    const unsupported = async (): Promise<never> => {
        throw new PlatformCapabilityUnavailableError('desktopSettings');
    };
    return {
        getDesktopSettings: unsupported,
        updateDesktopSettings: unsupported,
        openLogFolder: unsupported,
    };
}
