import {createNativeBridge, type NativeBridge} from '@/api/native-bridge';

export type PlatformKind = 'browser' | 'desktop';

export interface PlatformCapabilities {
    desktopAccount: boolean;
    desktopSettings: boolean;
    localNotifications: boolean;
    lmsWindow: boolean;
    mobilePairingManagement: boolean;
}

export type AccountAuthentication =
    | {kind: 'cookie'}
    | {kind: 'desktop-session'};

export interface PlatformAdapter {
    kind: PlatformKind;
    capabilities: PlatformCapabilities;
    accountAuthentication: AccountAuthentication;
    native: NativeBridge;
}

export class PlatformCapabilityUnavailableError extends Error {
    constructor(readonly capability: keyof PlatformCapabilities) {
        super(`PLATFORM_CAPABILITY_UNAVAILABLE:${capability}`);
        this.name = 'PlatformCapabilityUnavailableError';
    }
}

interface CreatePlatformAdapterOptions {
    runningInTauri: boolean;
    nativeBridge?: NativeBridge;
}

const BROWSER_CAPABILITIES: PlatformCapabilities = {
    desktopAccount: false,
    desktopSettings: false,
    localNotifications: false,
    lmsWindow: false,
    mobilePairingManagement: false,
};

const DESKTOP_CAPABILITIES: PlatformCapabilities = {
    desktopAccount: true,
    desktopSettings: true,
    localNotifications: true,
    lmsWindow: true,
    mobilePairingManagement: true,
};

export function createPlatformAdapter(options: CreatePlatformAdapterOptions): PlatformAdapter {
    if (options.runningInTauri) {
        return {
            kind: 'desktop',
            capabilities: DESKTOP_CAPABILITIES,
            accountAuthentication: {kind: 'desktop-session'},
            native: options.nativeBridge ?? createNativeBridge(),
        };
    }
    return {
        kind: 'browser',
        capabilities: BROWSER_CAPABILITIES,
        accountAuthentication: {kind: 'cookie'},
        native: unsupportedBrowserBridge(),
    };
}

function unsupportedBrowserBridge(): NativeBridge {
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
