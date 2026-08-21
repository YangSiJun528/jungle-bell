import type {PwaCapabilityAdapter, PwaInstallPrompt, PlatformUnlisten} from '@/platform/contracts';

import {isMobileInstallClient} from './install-client';

interface BeforeInstallPromptEvent extends Event {
    prompt(): Promise<void>;
    userChoice: Promise<{outcome: 'accepted' | 'dismissed'}>;
}

function isBeforeInstallPromptEvent(event: Event): event is BeforeInstallPromptEvent {
    return (
        'prompt' in event &&
        typeof event.prompt === 'function' &&
        'userChoice' in event &&
        event.userChoice instanceof Promise
    );
}

export function createPwaCapabilityAdapter(options: {
    production: boolean;
    windowObject?: Window;
    navigatorObject?: Navigator;
}): PwaCapabilityAdapter {
    const windowObject = options.windowObject ?? window;
    const navigatorObject = options.navigatorObject ?? navigator;
    let readyRegistration: ServiceWorkerRegistration | null = null;
    let registrationPromise: Promise<ServiceWorkerRegistration> | null = null;

    const startServiceWorker = (): Promise<ServiceWorkerRegistration> => {
        if (!options.production || !('serviceWorker' in navigatorObject)) {
            return Promise.reject(new Error('PUSH_UNSUPPORTED'));
        }
        if (readyRegistration) return Promise.resolve(readyRegistration);
        if (registrationPromise) return registrationPromise;

        registrationPromise = navigatorObject.serviceWorker
            .register('./sw.js', {scope: './'})
            .then(() => navigatorObject.serviceWorker.ready)
            .then((registration) => {
                readyRegistration = registration;
                return registration;
            })
            .catch((error: unknown) => {
                registrationPromise = null;
                throw error;
            });
        return registrationPromise;
    };

    return {
        available: true,
        installed: installedPwa(windowObject, navigatorObject),
        registerServiceWorker() {
            if (!options.production || !('serviceWorker' in navigatorObject)) return;
            const register = () => void startServiceWorker().catch(() => undefined);
            if (windowObject.document?.readyState === 'complete') {
                register();
            } else {
                windowObject.addEventListener('load', register, {once: true});
            }
        },
        async preparePush() {
            if (!('PushManager' in windowObject)) throw new Error('PUSH_UNSUPPORTED');
            await startServiceWorker();
        },
        subscribeInstallPrompt(listener): PlatformUnlisten {
            const handle = (event: Event) => {
                if (!isBeforeInstallPromptEvent(event)) return;
                event.preventDefault();
                listener(installPrompt(event));
            };
            windowObject.addEventListener('beforeinstallprompt', handle);
            return () => windowObject.removeEventListener('beforeinstallprompt', handle);
        },
        isMobileInstallClient: () => isMobileInstallClient(navigatorObject),
        subscribePush(applicationServerKey) {
            if (!('serviceWorker' in navigatorObject) || !('PushManager' in windowObject)) {
                return Promise.reject(new Error('PUSH_UNSUPPORTED'));
            }
            if (!readyRegistration) return Promise.reject(new Error('PUSH_NOT_READY'));

            try {
                // WebKit requires subscribe() itself to run while this click still
                // owns transient user activation. subscribe() also returns an
                // existing subscription when its options match.
                const subscription = readyRegistration.pushManager.subscribe({
                    userVisibleOnly: true,
                    applicationServerKey: decodeApplicationServerKey(applicationServerKey),
                });
                return subscription.then((value) => value.toJSON());
            } catch (error) {
                return Promise.reject(error);
            }
        },
    };
}

function installedPwa(windowObject: Window, navigatorObject: Navigator): boolean {
    const standaloneDisplay =
        typeof windowObject.matchMedia === 'function' &&
        windowObject.matchMedia('(display-mode: standalone)').matches;
    const iosStandalone = 'standalone' in navigatorObject && navigatorObject.standalone === true;
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
    const padding = '='.repeat((4 - (value.length % 4)) % 4);
    const binary = atob((value + padding).replace(/-/gu, '+').replace(/_/gu, '/'));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}
