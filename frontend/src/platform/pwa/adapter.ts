import type {
    PwaCapabilityAdapter,
    PwaInstallPrompt,
    PlatformUnlisten,
} from '@/platform/contracts';
import {isMobileInstallClient} from './install-client';

interface BeforeInstallPromptEvent extends Event {
    prompt(): Promise<void>;
    userChoice: Promise<{outcome: 'accepted' | 'dismissed'}>;
}

interface NotificationPermissionRequester {
    requestPermission(): Promise<NotificationPermission>;
}

export function createPwaCapabilityAdapter(options: {
    production: boolean;
    windowObject?: Window;
    navigatorObject?: Navigator;
    notificationObject?: NotificationPermissionRequester | null;
}): PwaCapabilityAdapter {
    const windowObject = options.windowObject ?? window;
    const navigatorObject = options.navigatorObject ?? navigator;
    const notificationObject = options.notificationObject === undefined
        ? typeof Notification === 'undefined' ? null : Notification
        : options.notificationObject;

    return {
        available: true,
        installed: installedPwa(windowObject, navigatorObject),
        registerServiceWorker() {
            if (!options.production || !('serviceWorker' in navigatorObject)) return;
            windowObject.addEventListener('load', () => {
                void navigatorObject.serviceWorker.register('./sw.js', {scope: './'});
            }, {once: true});
        },
        subscribeInstallPrompt(listener): PlatformUnlisten {
            const handle = (event: Event) => {
                event.preventDefault();
                listener(installPrompt(event as BeforeInstallPromptEvent));
            };
            windowObject.addEventListener('beforeinstallprompt', handle);
            return () => windowObject.removeEventListener('beforeinstallprompt', handle);
        },
        isMobileInstallClient: () => isMobileInstallClient(navigatorObject),
        async subscribePush(applicationServerKey) {
            if (!('serviceWorker' in navigatorObject)
                || !('PushManager' in windowObject)
                || !notificationObject) {
                throw new Error('PUSH_UNSUPPORTED');
            }
            const permission = await notificationObject.requestPermission();
            if (permission !== 'granted') throw new Error('PUSH_PERMISSION_DENIED');
            const registration = await navigatorObject.serviceWorker.ready;
            const existing = await registration.pushManager.getSubscription();
            const subscription = existing ?? await registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: decodeApplicationServerKey(applicationServerKey),
            });
            return subscription.toJSON();
        },
    };
}

function installedPwa(windowObject: Window, navigatorObject: Navigator): boolean {
    const standaloneDisplay = typeof windowObject.matchMedia === 'function'
        && windowObject.matchMedia('(display-mode: standalone)').matches;
    const iosStandalone = (navigatorObject as Navigator & {standalone?: boolean}).standalone === true;
    return standaloneDisplay || iosStandalone;
}

function installPrompt(event: BeforeInstallPromptEvent): PwaInstallPrompt {
    return {
        async prompt() {
            await event.prompt();
            return (await event.userChoice).outcome;
        },
    };
}

function decodeApplicationServerKey(value: string): ArrayBuffer {
    const padding = '='.repeat((4 - value.length % 4) % 4);
    const binary = atob((value + padding).replace(/-/gu, '+').replace(/_/gu, '/'));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
