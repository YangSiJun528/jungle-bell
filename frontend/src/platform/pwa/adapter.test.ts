import {describe, expect, it, vi} from 'vitest';

import type {PwaInstallPrompt} from '@/platform/contracts';

import {createPwaCapabilityAdapter} from './adapter';

function browserObjects(
    options: {
        standalone?: boolean;
        iosStandalone?: boolean;
        existingSubscription?: boolean;
    } = {},
) {
    const unsubscribe = vi.fn<PushSubscription['unsubscribe']>(async () => true);
    const toJSON = vi.fn<() => PushSubscriptionJSON>(() => ({
        endpoint: 'https://push.example/subscription',
    }));
    const subscription = {
        endpoint: 'https://push.example/subscription',
        toJSON,
        unsubscribe,
    } as unknown as PushSubscription;
    const getSubscription = vi.fn<PushManager['getSubscription']>(async () =>
        options.existingSubscription === false ? null : subscription,
    );
    const pushManager = {
        subscribe: vi.fn<PushManager['subscribe']>(async () => subscription),
        getSubscription,
    };
    const active = {
        state: 'activated',
        scriptURL: 'https://app.example/sw.js',
    } as ServiceWorker;
    const registration = {active, pushManager} as unknown as ServiceWorkerRegistration;
    const register = vi.fn<ServiceWorkerContainer['register']>(async () => registration);
    const getRegistration = vi.fn<ServiceWorkerContainer['getRegistration']>(async () =>
        Promise.resolve(registration),
    );
    const serviceWorker = {
        getRegistration,
        register,
        ready: Promise.resolve(registration),
    };
    const windowObject = Object.assign(new EventTarget(), {
        PushManager: class {},
        matchMedia: vi.fn<(query: string) => {matches: boolean}>(() => ({
            matches: options.standalone ?? false,
        })),
    }) as unknown as Window;
    const navigatorObject = {
        userAgent: 'Mozilla/5.0 (Linux; Android 16)',
        serviceWorker,
        standalone: options.iosStandalone ?? false,
    } as unknown as Navigator;
    return {
        navigatorObject,
        getSubscription,
        pushManager,
        register,
        subscription,
        toJSON,
        unsubscribe,
        windowObject,
    };
}

describe('PwaCapabilityAdapter', () => {
    it('일반 탭과 설치형 standalone 실행을 구분한다', () => {
        const browser = browserObjects();
        const standalone = browserObjects({standalone: true});
        const iosStandalone = browserObjects({iosStandalone: true});

        expect(
            createPwaCapabilityAdapter({
                production: true,
                windowObject: browser.windowObject,
                navigatorObject: browser.navigatorObject,
            }).installed,
        ).toBe(false);
        expect(
            createPwaCapabilityAdapter({
                production: true,
                windowObject: standalone.windowObject,
                navigatorObject: standalone.navigatorObject,
            }).installed,
        ).toBe(true);
        expect(
            createPwaCapabilityAdapter({
                production: true,
                windowObject: iosStandalone.windowObject,
                navigatorObject: iosStandalone.navigatorObject,
            }).installed,
        ).toBe(true);
    });

    it('production web에서 load 이후에만 서비스 워커를 등록한다', async () => {
        const browser = browserObjects();
        const adapter = createPwaCapabilityAdapter({
            production: true,
            windowObject: browser.windowObject,
            navigatorObject: browser.navigatorObject,
        });

        const registrationReady = adapter.registerServiceWorker();
        expect(adapter.getServiceWorkerContainer()).toBe(browser.navigatorObject.serviceWorker);
        expect(browser.register).not.toHaveBeenCalled();

        browser.windowObject.dispatchEvent(new Event('load'));
        await expect(registrationReady).resolves.toBe(
            await browser.navigatorObject.serviceWorker.ready,
        );
        await adapter.preparePush();

        expect(browser.register).toHaveBeenCalledWith('./sw.js', {scope: './'});
        expect(browser.register).toHaveBeenCalledOnce();
    });

    it('설치 프롬프트를 이벤트에서 어댑터 계약으로 변환하고 해제한다', async () => {
        const browser = browserObjects();
        const nativePrompt = vi.fn<() => Promise<void>>(async () => undefined);
        const listener = vi.fn<(prompt: PwaInstallPrompt) => void>();
        const adapter = createPwaCapabilityAdapter({
            production: false,
            windowObject: browser.windowObject,
            navigatorObject: browser.navigatorObject,
        });
        const unlisten = adapter.subscribeInstallPrompt(listener);
        const event = Object.assign(new Event('beforeinstallprompt', {cancelable: true}), {
            prompt: nativePrompt,
            userChoice: Promise.resolve({outcome: 'accepted' as const}),
        });

        browser.windowObject.dispatchEvent(event);

        expect(listener).toHaveBeenCalledOnce();
        await expect(listener.mock.calls[0]?.[0].prompt()).resolves.toBe('accepted');
        expect(nativePrompt).toHaveBeenCalledOnce();

        unlisten();
        browser.windowObject.dispatchEvent(event);
        expect(listener).toHaveBeenCalledOnce();
    });

    it('서비스 워커 준비 전에는 Push 구독을 시작하지 않는다', async () => {
        const browser = browserObjects();
        const adapter = createPwaCapabilityAdapter({
            production: true,
            windowObject: browser.windowObject,
            navigatorObject: browser.navigatorObject,
        });

        await expect(adapter.subscribePush('AQ')).rejects.toThrow('PUSH_NOT_READY');
        expect(browser.pushManager.subscribe).not.toHaveBeenCalled();

        await adapter.preparePush();
        await expect(adapter.subscribePush('AQ')).resolves.toEqual({
            endpoint: 'https://push.example/subscription',
        });
        expect(browser.pushManager.subscribe).toHaveBeenCalledWith({
            userVisibleOnly: true,
            applicationServerKey: expect.any(ArrayBuffer),
        });
    });

    it('구독 Promise가 끝나기 전에 PushManager.subscribe를 동기 호출한다', async () => {
        const browser = browserObjects();
        let resolveSubscription: ((subscription: PushSubscription) => void) | undefined;
        browser.pushManager.subscribe.mockImplementation(
            () =>
                new Promise<PushSubscription>((resolve) => {
                    resolveSubscription = resolve;
                }),
        );
        const adapter = createPwaCapabilityAdapter({
            production: true,
            windowObject: browser.windowObject,
            navigatorObject: browser.navigatorObject,
        });
        await adapter.preparePush();

        const subscription = adapter.subscribePush('AQ');

        expect(browser.pushManager.subscribe).toHaveBeenCalledOnce();
        resolveSubscription?.(browser.subscription);
        await expect(subscription).resolves.toEqual({
            endpoint: 'https://push.example/subscription',
        });
    });

    it('현재 로컬 Push 구독을 조회하고 직렬화한다', async () => {
        const browser = browserObjects();
        const adapter = createPwaCapabilityAdapter({
            production: true,
            windowObject: browser.windowObject,
            navigatorObject: browser.navigatorObject,
        });

        await expect(adapter.getPushSubscription()).resolves.toEqual({
            endpoint: 'https://push.example/subscription',
        });

        expect(browser.register).toHaveBeenCalledOnce();
        expect(browser.getSubscription).toHaveBeenCalledOnce();
        expect(browser.toJSON).toHaveBeenCalledOnce();
    });

    it('현재 로컬 Push 구독이 없으면 null을 반환한다', async () => {
        const browser = browserObjects({existingSubscription: false});
        const adapter = createPwaCapabilityAdapter({
            production: true,
            windowObject: browser.windowObject,
            navigatorObject: browser.navigatorObject,
        });

        await expect(adapter.getPushSubscription()).resolves.toBeNull();
    });

    it('서비스 워커 등록과 활성 script를 플랫폼 계약으로 관측한다', async () => {
        const browser = browserObjects();
        const adapter = createPwaCapabilityAdapter({
            production: true,
            windowObject: browser.windowObject,
            navigatorObject: browser.navigatorObject,
        });

        await expect(adapter.getServiceWorkerStatus()).resolves.toEqual({
            status: 'active',
            scriptUrl: 'https://app.example/sw.js',
        });
    });

    it('현재 로컬 Push 구독을 찾아 실제 브라우저 구독을 해제한다', async () => {
        const browser = browserObjects();
        const adapter = createPwaCapabilityAdapter({
            production: true,
            windowObject: browser.windowObject,
            navigatorObject: browser.navigatorObject,
        });

        await expect(adapter.unsubscribePush('https://push.example/subscription')).resolves.toBe(
            true,
        );

        expect(browser.pushManager.getSubscription).toHaveBeenCalledOnce();
        expect(browser.unsubscribe).toHaveBeenCalledOnce();
    });

    it('해제할 로컬 Push 구독이 없으면 false를 반환한다', async () => {
        const browser = browserObjects({existingSubscription: false});
        const adapter = createPwaCapabilityAdapter({
            production: true,
            windowObject: browser.windowObject,
            navigatorObject: browser.navigatorObject,
        });

        await expect(adapter.unsubscribePush('https://push.example/subscription')).resolves.toBe(
            false,
        );
        expect(browser.unsubscribe).not.toHaveBeenCalled();
    });

    it('조회와 해제 전 과정에서 같은 서비스 워커 등록을 재사용한다', async () => {
        const browser = browserObjects();
        browser.getSubscription
            .mockResolvedValueOnce(browser.subscription)
            .mockResolvedValueOnce(browser.subscription)
            .mockResolvedValueOnce(null);
        const adapter = createPwaCapabilityAdapter({
            production: true,
            windowObject: browser.windowObject,
            navigatorObject: browser.navigatorObject,
        });

        await expect(adapter.getPushSubscription()).resolves.toEqual({
            endpoint: 'https://push.example/subscription',
        });
        await expect(adapter.unsubscribePush('https://push.example/subscription')).resolves.toBe(
            true,
        );
        await expect(adapter.getPushSubscription()).resolves.toBeNull();

        expect(browser.register).toHaveBeenCalledOnce();
        expect(browser.getSubscription).toHaveBeenCalledTimes(3);
        expect(browser.unsubscribe).toHaveBeenCalledOnce();
    });

    it('조회 이후 구독 endpoint가 바뀌면 다른 구독을 해제하지 않는다', async () => {
        const browser = browserObjects();
        const replacementUnsubscribe = vi.fn<PushSubscription['unsubscribe']>(async () => true);
        const replacement = {
            endpoint: 'https://push.example/replacement',
            unsubscribe: replacementUnsubscribe,
        } as unknown as PushSubscription;
        browser.getSubscription
            .mockResolvedValueOnce(browser.subscription)
            .mockResolvedValueOnce(replacement);
        const adapter = createPwaCapabilityAdapter({
            production: true,
            windowObject: browser.windowObject,
            navigatorObject: browser.navigatorObject,
        });

        const observed = await adapter.getPushSubscription();

        await expect(adapter.unsubscribePush(observed?.endpoint ?? '')).rejects.toThrow(
            'PUSH_SUBSCRIPTION_CHANGED',
        );
        expect(browser.unsubscribe).not.toHaveBeenCalled();
        expect(replacementUnsubscribe).not.toHaveBeenCalled();
    });

    it('지원되지 않는 브라우저에서는 Push 요청 전에 실패한다', async () => {
        const windowObject = new EventTarget() as unknown as Window;
        const navigatorObject = {userAgent: 'test'} as Navigator;
        const adapter = createPwaCapabilityAdapter({
            production: true,
            windowObject,
            navigatorObject,
        });

        await expect(adapter.preparePush()).rejects.toThrow('PUSH_UNSUPPORTED');
        await expect(adapter.subscribePush('AQ')).rejects.toThrow('PUSH_UNSUPPORTED');
        await expect(adapter.getPushSubscription()).rejects.toThrow('PUSH_UNSUPPORTED');
        await expect(adapter.unsubscribePush('https://push.example/subscription')).rejects.toThrow(
            'PUSH_UNSUPPORTED',
        );
    });
});
