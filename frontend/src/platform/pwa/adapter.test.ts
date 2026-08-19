import {describe, expect, it, vi} from 'vitest';
import {createPwaCapabilityAdapter} from './adapter';

function browserObjects(options: {
    existingSubscription?: PushSubscription | null;
    standalone?: boolean;
    iosStandalone?: boolean;
} = {}) {
    const subscription = {
        toJSON: vi.fn(() => ({endpoint: 'https://push.example/subscription'})),
    } as unknown as PushSubscription;
    const pushManager = {
        getSubscription: vi.fn(async () => options.existingSubscription ?? null),
        subscribe: vi.fn(async () => subscription),
    };
    const register = vi.fn(async () => undefined);
    const serviceWorker = {
        register,
        ready: Promise.resolve({pushManager}),
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
            notificationObject: null,
        });

        adapter.registerServiceWorker();
        expect(browser.register).not.toHaveBeenCalled();

        browser.windowObject.dispatchEvent(new Event('load'));
        await Promise.resolve();

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
            notificationObject: null,
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

    it('알림 권한과 PushManager를 어댑터 내부에서만 사용한다', async () => {
        const browser = browserObjects();
        const requestPermission = vi.fn(async () => 'granted' as NotificationPermission);
        const adapter = createPwaCapabilityAdapter({
            production: true,
            windowObject: browser.windowObject,
            navigatorObject: browser.navigatorObject,
            notificationObject: {requestPermission},
        });

        await expect(adapter.subscribePush('AQ')).resolves.toEqual({
            endpoint: 'https://push.example/subscription',
        });
        expect(requestPermission).toHaveBeenCalledOnce();
        expect(browser.pushManager.subscribe).toHaveBeenCalledWith({
            userVisibleOnly: true,
            applicationServerKey: expect.any(ArrayBuffer),
        });
    });

    it('구독 Promise를 반환하기 전에 권한 요청을 즉시 시작한다', async () => {
        const browser = browserObjects();
        let grantPermission: ((permission: NotificationPermission) => void) | undefined;
        const requestPermission = vi.fn(() => new Promise<NotificationPermission>((resolve) => {
            grantPermission = resolve;
        }));
        const adapter = createPwaCapabilityAdapter({
            production: true,
            windowObject: browser.windowObject,
            navigatorObject: browser.navigatorObject,
            notificationObject: {requestPermission},
        });

        const subscription = adapter.subscribePush('AQ');

        expect(requestPermission).toHaveBeenCalledOnce();
        expect(browser.pushManager.getSubscription).not.toHaveBeenCalled();
        grantPermission?.('granted');
        await expect(subscription).resolves.toEqual({endpoint: 'https://push.example/subscription'});
    });

    it('지원되지 않는 브라우저에서는 Push 요청 전에 실패한다', async () => {
        const windowObject = new EventTarget() as unknown as Window;
        const navigatorObject = {userAgent: 'test'} as Navigator;
        const adapter = createPwaCapabilityAdapter({
            production: true,
            windowObject,
            navigatorObject,
            notificationObject: null,
        });

        await expect(adapter.subscribePush('AQ')).rejects.toThrow('PUSH_UNSUPPORTED');
    });
});
