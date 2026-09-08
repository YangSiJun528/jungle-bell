import {useEffect, useEffectEvent} from 'react';

export const PWA_RELOAD_HANDOFF_KEY = 'jungle-bell:pwa-reload-handoff:v1';

export type PwaReloadPreserver = () => boolean | Promise<boolean>;

export interface PwaReloadPreserverRegistry {
    register(preserver: PwaReloadPreserver): () => void;
    preserve(): Promise<boolean>;
}

export interface PwaReloadStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
}

export function createPwaReloadPreserverRegistry(): PwaReloadPreserverRegistry {
    const preservers = new Set<PwaReloadPreserver>();
    return {
        register(preserver) {
            preservers.add(preserver);
            return () => {
                preservers.delete(preserver);
            };
        },
        async preserve() {
            try {
                const results = await Promise.all(
                    Array.from(preservers, (preserver) => Promise.resolve(preserver())),
                );
                return results.every(Boolean);
            } catch {
                return false;
            }
        },
    };
}

export const pwaReloadPreservers = createPwaReloadPreserverRegistry();

export function usePwaReloadPreserver(preserver: PwaReloadPreserver): void {
    const preserveLatest = useEffectEvent(preserver);
    useEffect(() => pwaReloadPreservers.register(() => preserveLatest()), []);
}

function browserSessionStorage(): PwaReloadStorage | null {
    try {
        return typeof window === 'undefined' ? null : window.sessionStorage;
    } catch {
        return null;
    }
}

export async function preparePwaReload({
    registry = pwaReloadPreservers,
    storage = browserSessionStorage(),
    route = typeof window === 'undefined' ? '' : window.location.hash,
    now = Date.now,
}: {
    registry?: PwaReloadPreserverRegistry;
    storage?: PwaReloadStorage | null;
    route?: string;
    now?: () => number;
} = {}): Promise<boolean> {
    if (!(await registry.preserve()) || !storage) return false;
    try {
        storage.setItem(
            PWA_RELOAD_HANDOFF_KEY,
            JSON.stringify({version: 1, route, savedAt: new Date(now()).toISOString()}),
        );
        return true;
    } catch {
        return false;
    }
}
