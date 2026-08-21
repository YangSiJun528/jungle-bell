import {
    createMobileInstallationIdProvider,
    MOBILE_INSTALLATION_KEY,
} from './lib/mobile-installation';

export const mobileInstallationId = createMobileInstallationIdProvider({
    read: () => window.localStorage.getItem(MOBILE_INSTALLATION_KEY),
    write: (value) => window.localStorage.setItem(MOBILE_INSTALLATION_KEY, value),
    randomBytes: (length) => crypto.getRandomValues(new Uint8Array(length)),
});

export function mobileDeviceLabel(): string {
    const platform = navigator.platform.trim();
    return platform ? `Jungle Bell · ${platform}`.slice(0, 80) : 'Jungle Bell 모바일';
}
