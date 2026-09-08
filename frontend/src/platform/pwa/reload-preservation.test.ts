import {describe, expect, it, vi} from 'vitest';

import {
    PWA_RELOAD_HANDOFF_KEY,
    createPwaReloadPreserverRegistry,
    preparePwaReload,
} from './reload-preservation';

function memoryStorage() {
    const values = new Map<string, string>();
    return {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
    };
}

describe('PWA reload preservation', () => {
    it('등록된 보존 훅이 모두 성공한 뒤 versioned handoff를 session storage에 기록한다', async () => {
        const registry = createPwaReloadPreserverRegistry();
        const preserve = vi.fn<() => Promise<boolean>>(async () => true);
        registry.register(preserve);
        const storage = memoryStorage();

        await expect(
            preparePwaReload({
                registry,
                storage,
                route: '#/connections?tab=devices',
                now: () => Date.parse('2026-09-08T00:00:00.000Z'),
            }),
        ).resolves.toBe(true);

        expect(preserve).toHaveBeenCalledOnce();
        expect(JSON.parse(storage.getItem(PWA_RELOAD_HANDOFF_KEY) ?? '')).toEqual({
            version: 1,
            route: '#/connections?tab=devices',
            savedAt: '2026-09-08T00:00:00.000Z',
        });
    });

    it('보존 훅이 거부하거나 storage 기록에 실패하면 무단 reload를 취소한다', async () => {
        const registry = createPwaReloadPreserverRegistry();
        registry.register(async () => false);

        await expect(
            preparePwaReload({registry, storage: memoryStorage(), route: '#/home'}),
        ).resolves.toBe(false);

        const allowed = createPwaReloadPreserverRegistry();
        await expect(
            preparePwaReload({
                registry: allowed,
                storage: {
                    getItem: () => null,
                    setItem: () => {
                        throw new Error('blocked');
                    },
                },
                route: '#/home',
            }),
        ).resolves.toBe(false);
    });
});
