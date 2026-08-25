import {
    type DesktopSettingsAdapter,
    type NativeBridge,
    type PlatformAdapter,
    PlatformCapabilityUnavailableError,
    type PlatformCapabilities,
    type PwaCapabilityAdapter,
    type UsagePrivacyAdapter,
    unavailableEventAdapter,
    unavailableUsagePrivacyAdapter,
} from '@/platform/contracts';

const BASE_CAPABILITIES: PlatformCapabilities = {
    desktopAccount: false,
    desktopSettings: false,
    laundryRiskIndicator: false,
    localNotifications: false,
    lmsWindow: false,
    mobilePairingManagement: false,
    pwaInstall: false,
    webPush: false,
};

function unsupportedNativeCapability(capability: keyof PlatformCapabilities): () => Promise<never> {
    return async () => {
        throw new PlatformCapabilityUnavailableError(capability);
    };
}

async function unsupportedDesktopSetting(): Promise<never> {
    throw new PlatformCapabilityUnavailableError('desktopSettings');
}

export function createWebPlatformAdapter(
    pwa: PwaCapabilityAdapter,
    usagePrivacy: UsagePrivacyAdapter = unavailableUsagePrivacyAdapter(),
): PlatformAdapter {
    const native = unsupportedNativeBridge();
    const installedPwa = pwa.available && pwa.installed;
    return {
        kind: 'browser',
        capabilities: {
            ...BASE_CAPABILITIES,
            laundryRiskIndicator: installedPwa,
            pwaInstall: pwa.available,
            webPush: installedPwa,
        },
        accountAuthentication: installedPwa ? {kind: 'cookie'} : {kind: 'none'},
        native,
        desktopSettings: unsupportedDesktopSettings(),
        events: unavailableEventAdapter(),
        pwa,
        usagePrivacy,
    };
}

function unsupportedNativeBridge(): NativeBridge {
    return {
        bootstrapDesktopHttpSession: unsupportedNativeCapability('desktopAccount'),
        getDesktopSettings: unsupportedNativeCapability('desktopSettings'),
        updateDesktopSettings: unsupportedNativeCapability('desktopSettings'),
        checkDesktopUpdate: unsupportedNativeCapability('desktopSettings'),
        installDesktopUpdate: unsupportedNativeCapability('desktopSettings'),
        openLogFolder: unsupportedNativeCapability('desktopSettings'),
        openSystemNotificationSettings: unsupportedNativeCapability('localNotifications'),
        getDesktopConnectionState: unsupportedNativeCapability('desktopAccount'),
        resetDesktopIdentity: unsupportedNativeCapability('desktopAccount'),
        refreshPlatformSync: unsupportedNativeCapability('desktopAccount'),
        openLmsLogin: unsupportedNativeCapability('lmsWindow'),
        getNotificationInboxSnapshot: unsupportedNativeCapability('localNotifications'),
        markNotificationRead: unsupportedNativeCapability('localNotifications'),
        markAllNotificationsRead: unsupportedNativeCapability('localNotifications'),
        activateNotification: unsupportedNativeCapability('localNotifications'),
        sendTestNotification: unsupportedNativeCapability('localNotifications'),
    };
}

function unsupportedDesktopSettings(): DesktopSettingsAdapter {
    return {
        getDesktopSettings: unsupportedDesktopSetting,
        updateDesktopSettings: unsupportedDesktopSetting,
        checkDesktopUpdate: unsupportedDesktopSetting,
        installDesktopUpdate: unsupportedDesktopSetting,
        openLogFolder: unsupportedDesktopSetting,
        openSystemNotificationSettings: unsupportedDesktopSetting,
    };
}
