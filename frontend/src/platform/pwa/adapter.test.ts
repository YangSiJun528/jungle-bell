import {describe, expect, it, vi} from 'vitest';
import {createPwaCapabilityAdapter} from './adapter';

function browserObjects(options: {
    standalone?: boolean;
    iosStandalone?: boolean;
} = {}) {
    const subscription = {
        toJSON: vi.fn(() => ({endpoint: 'https://push.example/subscription'})),
    } as unknown as PushSubscription;
    const pushManager = {
        subscribe: vi.fn(async () => subscription),
    };
    const registration = {pushManager} as unknown as ServiceWorkerRegistration;
    const register = vi.fn(async () => registration);
    const serviceWorker = {
        register,
        ready: Promise.resolve(registration),
    };
    const windowObject = Object.assign(new EventTarget(), {
        PushManager: class {},
        matchMedia: vi.fn(() => ({matches: options.standalone ?? false})),
    }) as unknown as Window;
    const navigatorObject = {
        userAgent: 'Mozilla/5.0 (Linux; Android 16)',
        serviceWorker,
        standalone: options.iosStandalone ?? false,
    } as unknown as Navigator;
    return {navigatorObject, pushManager, register, subscription, windowObject};
}

describe('PwaCapabilityAdapter', () => {
    it('일반 탭과 설치형 standalone 실행을 구분한다', () => {
        const browser = browserObjects();
        const standalone = browserObjects({standalone: true});
        const iosStandalone = browserObjects({iosStandalone: true});

        expect(createPwaCapabilityAdapter({
            production: true,
            windowObject: browser.windowObject,
            navigatorObject: browser.navigatorObject,
        }).installed).toBe(false);
        expect(createPwaCapabilityAdapter({
            production: true,
            windowObject: standalone.windowObject,
            navigatorObject: standalone.navigatorObject,
        }).installed).toBe(true);
        expect(createPwaCapabilityAdapter({
            production: true,
            windowObject: iosStandalone.windowObject,
            navigatorObject: iosStandalone.navigatorObject,
        }).installed).toBe(true);
    });

    it('production web에서 load 이후에만 서비스 워커를 등록한다', async () => {
        const browser = browserObjects();
        const adapter = createPwaCapabilityAdapter({
            production: true,
            windowObject: browser.windowObject,
            navigatorObject: browser.navigatorObject,
        });

        adapter.registerServiceWorker();
        expect(browser.register).not.toHaveBeenCalled();

        browser.windowObject.dispatchEvent(new Event('load'));
        await adapter.preparePush();

        expect(browser.register).toHaveBeenCalledWith('./sw.js', {scope: './'});
    });

    it('설치 프롬프트를 이벤트에서 어댑터 계약으로 변환하고 해제한다', async () => {
        const browser = browserObjects();
        const nativePrompt = vi.fn(async () => undefined);
        const listener = vi.fn();
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
        browser.pushManager.subscribe.mockImplementation(() => new Promise<PushSubscription>((resolve) => {
            resolveSubscription = resolve;
        }));
        const adapter = createPwaCapabilityAdapter({
            production: true,
            windowObject: browser.windowObject,
            navigatorObject: browser.navigatorObject,
        });
        await adapter.preparePush();

        const subscription = adapter.subscribePush('AQ');

        expect(browser.pushManager.subscribe).toHaveBeenCalledOnce();
        resolveSubscription?.(browser.subscription);
        await expect(subscription).resolves.toEqual({endpoint: 'https://push.example/subscription'});
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
    });
});
