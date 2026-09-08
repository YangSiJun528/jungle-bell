import {readFileSync} from 'node:fs';

import {describe, expect, it, vi} from 'vitest';

import {createPwaUpdateBootstrap} from './update-bootstrap';

class WaitingWorker extends EventTarget {
    state: ServiceWorkerState = 'installed';
    postMessage = vi.fn<ServiceWorker['postMessage']>();
}

describe('createPwaUpdateBootstrap', () => {
    it('실제 ready registration의 waiting worker를 lifecycle에 연결한다', async () => {
        const worker = new WaitingWorker();
        const registration = Object.assign(new EventTarget(), {
            installing: null,
            waiting: worker,
        }) as unknown as ServiceWorkerRegistration;
        const serviceWorker = Object.assign(new EventTarget(), {
            controller: {} as ServiceWorker,
        }) as unknown as ServiceWorkerContainer;

        const bootstrap = createPwaUpdateBootstrap({
            enabled: true,
            serviceWorker,
            registrationReady: Promise.resolve(registration),
            reloadPage: vi.fn<() => void>(),
        });

        expect(bootstrap).not.toBeNull();
        await bootstrap?.ready;
        expect(bootstrap?.getSnapshot()).toEqual({status: 'ready', error: null});
    });

    it('비활성 대상에서는 service worker lifecycle을 만들지 않는다', () => {
        expect(
            createPwaUpdateBootstrap({
                enabled: false,
                serviceWorker: null,
                registrationReady: null,
                reloadPage: vi.fn<() => void>(),
            }),
        ).toBeNull();
    });

    it('최초 등록 실패 뒤에도 같은 capability adapter 경로로 다시 등록한다', async () => {
        const worker = new WaitingWorker();
        const update = vi.fn<ServiceWorkerRegistration['update']>();
        const registration = Object.assign(new EventTarget(), {
            installing: null,
            waiting: worker,
            update,
        }) as unknown as ServiceWorkerRegistration;
        update.mockResolvedValue(registration);
        const serviceWorker = Object.assign(new EventTarget(), {
            controller: {} as ServiceWorker,
        }) as unknown as ServiceWorkerContainer;
        const retryRegistration = vi.fn<() => Promise<ServiceWorkerRegistration>>(async () =>
            Promise.resolve(registration),
        );
        const bootstrap = createPwaUpdateBootstrap({
            enabled: true,
            serviceWorker,
            registrationReady: Promise.reject(new Error('registration failed')),
            retryRegistration,
            reloadPage: vi.fn<() => void>(),
        });

        await expect(bootstrap?.ready).rejects.toThrow('registration failed');
        await expect(bootstrap?.retryObservation()).resolves.toBeUndefined();
        expect(retryRegistration).toHaveBeenCalledOnce();
        expect(bootstrap?.getSnapshot().status).toBe('ready');
    });

    it('app bootstrap은 capability adapter가 반환한 동일 registration Promise를 사용한다', () => {
        const source = readFileSync(new URL('../../app/bootstrap.tsx', import.meta.url), 'utf8');

        expect(source).toContain('const registrationReady = platform.pwa.registerServiceWorker();');
        expect(source).toContain('serviceWorker: platform.pwa.getServiceWorkerContainer(),');
        expect(source).toContain('registrationReady,');
        expect(source).toContain('retryRegistration: () => platform.pwa.registerServiceWorker(),');
        expect(source).not.toContain('navigator.serviceWorker');
    });
});
