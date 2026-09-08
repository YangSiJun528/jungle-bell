import type {
    NativeBridge,
    PlatformAdapter,
    PlatformEventAdapter,
    PwaCapabilityAdapter,
} from '@/platform/contracts';
import {unavailablePwaAdapter, unavailableUsagePrivacyAdapter} from '@/platform/contracts';

import {createDesktopHttpSessionManager} from './desktop-http-session';
import {createDashboardDesktopSettingsApi} from './desktop-settings';
import {createTauriEventAdapter} from './event-adapter';
import {createTauriExternalLinkAdapter, type TauriExternalLinkAdapter} from './external-links';
import {createTauriLifecycleAdapter, type TauriLifecycleAdapter} from './lifecycle';
import {createNativeBridge} from './native-bridge';

export interface TauriPlatformAdapter extends PlatformAdapter {
    externalLinks: TauriExternalLinkAdapter;
    lifecycle: TauriLifecycleAdapter;
}

export function createTauriPlatformAdapter(
    options: {
        nativeBridge?: NativeBridge;
        events?: PlatformEventAdapter;
        externalLinks?: TauriExternalLinkAdapter;
        lifecycle?: TauriLifecycleAdapter;
        pwa?: PwaCapabilityAdapter;
    } = {},
): TauriPlatformAdapter {
    const native = options.nativeBridge ?? createNativeBridge();
    return {
        kind: 'desktop',
        capabilities: {
            desktopAccount: true,
            desktopSettings: true,
            laundryRiskIndicator: true,
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
        externalLinks: options.externalLinks ?? createTauriExternalLinkAdapter(),
        lifecycle: options.lifecycle ?? createTauriLifecycleAdapter(),
        pwa: options.pwa ?? unavailablePwaAdapter(),
        usagePrivacy: unavailableUsagePrivacyAdapter(),
    };
}
