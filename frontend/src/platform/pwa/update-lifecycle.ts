export const PWA_ACTIVATE_UPDATE_MESSAGE = 'JUNGLE_BELL_ACTIVATE_UPDATE';

export type PwaUpdateStatus = 'idle' | 'installing' | 'ready' | 'activating' | 'failed';

export interface PwaUpdateSnapshot {
    readonly status: PwaUpdateStatus;
    readonly error: string | null;
}

export type PrepareForPwaReload = () => boolean | Promise<boolean>;

export interface PwaUpdateLifecycle {
    getSnapshot(): PwaUpdateSnapshot;
    subscribe(listener: (snapshot: PwaUpdateSnapshot) => void): () => void;
    observeRegistration(registration: ServiceWorkerRegistration): void;
    activateWhenSafe(prepareForReload: PrepareForPwaReload): Promise<'cancelled' | 'reloading'>;
}

interface PwaUpdateLifecycleOptions {
    serviceWorker: ServiceWorkerContainer;
    reloadPage: () => void;
    activationTimeoutMs?: number;
}

const IDLE_SNAPSHOT: PwaUpdateSnapshot = Object.freeze({status: 'idle', error: null});

export function createPwaUpdateLifecycle(options: PwaUpdateLifecycleOptions): PwaUpdateLifecycle {
    const activationTimeoutMs = options.activationTimeoutMs ?? 10_000;
    const listeners = new Set<(snapshot: PwaUpdateSnapshot) => void>();
    const observedRegistrations = new WeakSet<ServiceWorkerRegistration>();
    const observedWorkers = new WeakSet<ServiceWorker>();
    let snapshot = IDLE_SNAPSHOT;
    let waitingWorker: ServiceWorker | null = null;

    const publish = (status: PwaUpdateStatus, error: string | null = null): void => {
        if (snapshot.status === status && snapshot.error === error) return;
        snapshot = Object.freeze({status, error});
        for (const listener of listeners) listener(snapshot);
    };

    const markReady = (worker: ServiceWorker): void => {
        waitingWorker = worker;
        publish('ready');
    };

    const observeInstallingWorker = (
        registration: ServiceWorkerRegistration,
        worker: ServiceWorker,
    ): void => {
        if (observedWorkers.has(worker)) return;
        observedWorkers.add(worker);
        publish('installing');

        const syncWorkerState = (): void => {
            if (worker.state === 'installed') {
                if (options.serviceWorker.controller) {
                    markReady(registration.waiting ?? worker);
                } else {
                    waitingWorker = null;
                    publish('idle');
                }
            } else if (worker.state === 'redundant') {
                waitingWorker = null;
                publish('failed', 'PWA_UPDATE_INSTALL_FAILED');
            }
        };
        worker.addEventListener('statechange', syncWorkerState);
        syncWorkerState();
    };

    const observeRegistration = (registration: ServiceWorkerRegistration): void => {
        if (registration.waiting && options.serviceWorker.controller) {
            markReady(registration.waiting);
        }
        if (observedRegistrations.has(registration)) return;
        observedRegistrations.add(registration);

        if (registration.installing) {
            observeInstallingWorker(registration, registration.installing);
        }
        registration.addEventListener('updatefound', () => {
            const worker = registration.installing;
            if (worker) observeInstallingWorker(registration, worker);
        });
    };

    const waitForControllerChange = (worker: ServiceWorker): Promise<void> =>
        new Promise<void>((resolve, reject) => {
            let settled = false;
            const finish = (callback: () => void): void => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                options.serviceWorker.removeEventListener('controllerchange', handleChange);
                callback();
            };
            const handleChange = (): void => finish(resolve);
            const timeout = setTimeout(
                () => finish(() => reject(new Error('PWA_UPDATE_ACTIVATION_TIMEOUT'))),
                activationTimeoutMs,
            );
            options.serviceWorker.addEventListener('controllerchange', handleChange);
            try {
                worker.postMessage({type: PWA_ACTIVATE_UPDATE_MESSAGE}, []);
            } catch {
                finish(() => reject(new Error('PWA_UPDATE_ACTIVATION_FAILED')));
            }
        });

    return {
        getSnapshot: () => snapshot,
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        observeRegistration,
        async activateWhenSafe(prepareForReload) {
            if (snapshot.status !== 'ready' || !waitingWorker) {
                throw new Error('PWA_UPDATE_NOT_READY');
            }
            const worker = waitingWorker;
            publish('activating');

            let prepared: boolean;
            try {
                prepared = await prepareForReload();
            } catch (error) {
                publish('ready');
                throw error;
            }
            if (!prepared) {
                publish('ready');
                return 'cancelled';
            }

            try {
                await waitForControllerChange(worker);
                options.reloadPage();
                return 'reloading';
            } catch (error) {
                const code =
                    error instanceof Error && error.message.startsWith('PWA_UPDATE_')
                        ? error.message
                        : 'PWA_UPDATE_ACTIVATION_FAILED';
                publish('failed', code);
                throw new Error(code, {cause: error});
            }
        },
    };
}
