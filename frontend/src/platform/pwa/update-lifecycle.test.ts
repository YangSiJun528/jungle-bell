import {describe, expect, it, vi} from 'vitest';

import {
    PWA_ACTIVATE_UPDATE_MESSAGE,
    createPwaUpdateLifecycle,
    type PwaUpdateSnapshot,
} from './update-lifecycle';

class FakeServiceWorker extends EventTarget {
    state: ServiceWorkerState = 'installing';
    postMessage = vi.fn<ServiceWorker['postMessage']>();

    transitionTo(state: ServiceWorkerState): void {
        this.state = state;
        this.dispatchEvent(new Event('statechange'));
    }
}

interface MutableRegistration {
    installing: ServiceWorker | null;
    waiting: ServiceWorker | null;
}

function serviceWorkerEnvironment(options: {controlled?: boolean; waiting?: boolean} = {}) {
    const container = Object.assign(new EventTarget(), {
        controller: options.controlled === false ? null : ({} as ServiceWorker),
    }) as unknown as ServiceWorkerContainer;
    const worker = new FakeServiceWorker();
    const registration = Object.assign(new EventTarget(), {
        installing: null,
        waiting: options.waiting ? worker : null,
    }) as unknown as ServiceWorkerRegistration & MutableRegistration;
    const reloadPage = vi.fn<() => void>();
    const lifecycle = createPwaUpdateLifecycle({
        serviceWorker: container,
        reloadPage,
        activationTimeoutMs: 50,
    });
    return {container, lifecycle, registration, reloadPage, worker};
}

describe('PwaUpdateLifecycle', () => {
    it('등록 시 이미 waiting인 업데이트를 즉시 ready로 노출한다', () => {
        const browser = serviceWorkerEnvironment({waiting: true});

        browser.lifecycle.observeRegistration(browser.registration);

        expect(browser.lifecycle.getSnapshot()).toEqual({status: 'ready', error: null});
    });

    it('updatefound의 installing worker가 설치되면 ready 상태를 발행한다', () => {
        const browser = serviceWorkerEnvironment();
        const listener = vi.fn<(snapshot: PwaUpdateSnapshot) => void>();
        browser.lifecycle.subscribe(listener);
        browser.lifecycle.observeRegistration(browser.registration);

        browser.registration.installing = browser.worker as unknown as ServiceWorker;
        browser.registration.dispatchEvent(new Event('updatefound'));
        expect(browser.lifecycle.getSnapshot()).toEqual({status: 'installing', error: null});

        browser.registration.waiting = browser.worker as unknown as ServiceWorker;
        browser.worker.transitionTo('installed');

        expect(browser.lifecycle.getSnapshot()).toEqual({status: 'ready', error: null});
        expect(listener).toHaveBeenLastCalledWith({status: 'ready', error: null});
    });

    it('첫 설치처럼 기존 controller가 없으면 업데이트 ready로 오인하지 않는다', () => {
        const browser = serviceWorkerEnvironment({controlled: false});
        browser.lifecycle.observeRegistration(browser.registration);

        browser.registration.installing = browser.worker as unknown as ServiceWorker;
        browser.registration.dispatchEvent(new Event('updatefound'));
        browser.worker.transitionTo('installed');

        expect(browser.lifecycle.getSnapshot()).toEqual({status: 'idle', error: null});
    });

    it('입력 보존 handshake가 끝난 뒤에만 새 worker를 활성화하고 controller 교체 후 reload한다', async () => {
        const browser = serviceWorkerEnvironment({waiting: true});
        browser.lifecycle.observeRegistration(browser.registration);
        let finishPreparing: (() => void) | undefined;
        const preservedDrafts: string[] = [];
        const prepareForReload = vi.fn<() => Promise<true>>(
            () =>
                new Promise<true>((resolve) => {
                    finishPreparing = () => {
                        preservedDrafts.push('세탁 메모 초안');
                        resolve(true);
                    };
                }),
        );

        const activation = browser.lifecycle.activateWhenSafe(prepareForReload);

        expect(browser.worker.postMessage).not.toHaveBeenCalled();
        finishPreparing?.();
        await vi.waitFor(() => expect(browser.worker.postMessage).toHaveBeenCalledOnce());
        expect(preservedDrafts).toEqual(['세탁 메모 초안']);
        expect(browser.worker.postMessage).toHaveBeenCalledWith(
            {type: PWA_ACTIVATE_UPDATE_MESSAGE},
            [],
        );
        expect(browser.reloadPage).not.toHaveBeenCalled();

        browser.container.dispatchEvent(new Event('controllerchange'));

        await expect(activation).resolves.toBe('reloading');
        expect(browser.reloadPage).toHaveBeenCalledOnce();
    });

    it('입력 보존을 취소하면 waiting worker와 현재 문서를 그대로 둔다', async () => {
        const browser = serviceWorkerEnvironment({waiting: true});
        browser.lifecycle.observeRegistration(browser.registration);

        await expect(browser.lifecycle.activateWhenSafe(async () => false)).resolves.toBe(
            'cancelled',
        );

        expect(browser.worker.postMessage).not.toHaveBeenCalled();
        expect(browser.reloadPage).not.toHaveBeenCalled();
        expect(browser.lifecycle.getSnapshot().status).toBe('ready');
    });

    it('controller 교체가 확인되지 않으면 reload하지 않고 실패 상태를 노출한다', async () => {
        vi.useFakeTimers();
        const browser = serviceWorkerEnvironment({waiting: true});
        browser.lifecycle.observeRegistration(browser.registration);

        const failure = browser.lifecycle
            .activateWhenSafe(async () => true)
            .catch((error: unknown) => error);
        await vi.runAllTimersAsync();

        await expect(failure).resolves.toMatchObject({
            message: 'PWA_UPDATE_ACTIVATION_TIMEOUT',
        });
        expect(browser.reloadPage).not.toHaveBeenCalled();
        expect(browser.lifecycle.getSnapshot()).toEqual({
            status: 'failed',
            error: 'PWA_UPDATE_ACTIVATION_TIMEOUT',
        });
        vi.useRealTimers();
    });
});
