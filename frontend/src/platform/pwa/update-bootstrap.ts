import {createPwaUpdateLifecycle, type PwaUpdateLifecycle} from './update-lifecycle';

export interface PwaUpdateBootstrap extends PwaUpdateLifecycle {
    readonly ready: Promise<void>;
    retryObservation(): Promise<void>;
}

export function createPwaUpdateBootstrap(options: {
    enabled: boolean;
    serviceWorker: ServiceWorkerContainer | null;
    registrationReady: Promise<ServiceWorkerRegistration | null> | null;
    retryRegistration?: () => Promise<ServiceWorkerRegistration | null>;
    reloadPage: () => void;
    activationTimeoutMs?: number;
}): PwaUpdateBootstrap | null {
    if (!options.enabled || !options.serviceWorker || !options.registrationReady) return null;

    const lifecycle = createPwaUpdateLifecycle({
        serviceWorker: options.serviceWorker,
        reloadPage: options.reloadPage,
        activationTimeoutMs: options.activationTimeoutMs,
    });
    let registration: ServiceWorkerRegistration | null = null;
    const ready = options.registrationReady.then((resolved) => {
        if (!resolved) throw new Error('PWA_UPDATE_REGISTRATION_UNAVAILABLE');
        registration = resolved;
        lifecycle.observeRegistration(resolved);
        return undefined;
    });

    return {
        ...lifecycle,
        ready,
        async retryObservation() {
            const resolved =
                registration ??
                (await (options.retryRegistration?.() ?? options.registrationReady));
            if (!resolved) throw new Error('PWA_UPDATE_REGISTRATION_UNAVAILABLE');
            registration = resolved;
            lifecycle.observeRegistration(resolved);
            await resolved.update();
        },
    };
}
