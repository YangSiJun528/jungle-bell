import type {
    NativeBridge,
    PlatformAdapter,
    PlatformEventAdapter,
    PwaCapabilityAdapter,
} from '@/platform/contracts';
import {unavailablePwaAdapter} from '@/platform/contracts';
import {createDashboardDesktopSettingsApi} from './desktop-settings';
import {createDesktopHttpSessionManager} from './desktop-http-session';
import {createTauriEventAdapter} from './event-adapter';
import {createNativeBridge} from './native-bridge';

export function createTauriPlatformAdapter(options: {
    nativeBridge?: NativeBridge;
    events?: PlatformEventAdapter;
    pwa?: PwaCapabilityAdapter;
} = {}): PlatformAdapter {
    const native = options.nativeBridge ?? createNativeBridge();
    return {
        kind: 'desktop',
        capabilities: {
            desktopAccount: true,
            desktopSettings: true,
            localNotifications: true,
            lmsWindow: true,
            mobilePairingManagement: true,
            pwaInstall: false,
            webPush: false,
        },
        accountAuthentication: {
            kind: 'desktop-session',
            session: createDesktopHttpSessionManager({nativeBridge: native}),
        },
        native,
        desktopSettings: createDashboardDesktopSettingsApi(native),
        events: options.events ?? createTauriEventAdapter(),
        pwa: options.pwa ?? unavailablePwaAdapter(),
    };
}
