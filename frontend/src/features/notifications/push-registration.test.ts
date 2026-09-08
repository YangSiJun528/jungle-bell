import {describe, expect, test, vi} from 'vitest';

import {
    PUSH_SUBSCRIPTION_LIFECYCLE_STORAGE_KEY,
    type PushSubscriptionLifecycleStorage,
} from '@/api/push-subscription-lifecycle';

import {
    preparePushSubscriptionRegistration,
    storePushSubscriptionRegistration,
} from './push-registration';

class MemoryStorage implements PushSubscriptionLifecycleStorage {
    readonly values = new Map<string, string>();

    getItem(key: string): string | null {
        return this.values.get(key) ?? null;
    }

    setItem(key: string, value: string): void {
        this.values.set(key, value);
    }

    removeItem(key: string): void {
        this.values.delete(key);
    }
}

const subscription = (endpoint: string): PushSubscriptionJSON => ({
    endpoint,
    expirationTime: null,
    keys: {auth: 'auth', p256dh: 'p256dh'},
});

describe('push registration metadata', () => {
    test('검증된 등록 ID와 endpoint 지문만 저장한다', async () => {
        const storage = new MemoryStorage();
        const endpoint = 'https://push.example/subscription/private';

        const metadata = await storePushSubscriptionRegistration({
            storage,
            subscription: subscription(endpoint),
            subscriptionId: `jbps_${'a'.repeat(64)}`,
        });

        expect(metadata.cleanupPhase).toBe('registered');
        expect(metadata.endpointFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/u);
        expect(storage.getItem(PUSH_SUBSCRIPTION_LIFECYCLE_STORAGE_KEY)).not.toContain(endpoint);
    });

    test('같은 로컬 구독 재등록은 기존 서버 등록을 먼저 지우지 않는다', async () => {
        const storage = new MemoryStorage();
        const local = subscription('https://push.example/subscription/same');
        await storePushSubscriptionRegistration({
            storage,
            subscription: local,
            subscriptionId: `jbps_${'b'.repeat(64)}`,
        });
        const unregisterServer = vi.fn<(id: string) => Promise<void>>(async () => undefined);

        await expect(
            preparePushSubscriptionRegistration({storage, subscription: local, unregisterServer}),
        ).resolves.toEqual({status: 'ready', priorCleanup: 'not-needed'});
        expect(unregisterServer).not.toHaveBeenCalled();
    });

    test('바뀐 endpoint의 옛 서버 등록을 먼저 제거한 뒤 메타데이터를 비운다', async () => {
        const storage = new MemoryStorage();
        await storePushSubscriptionRegistration({
            storage,
            subscription: subscription('https://push.example/subscription/old'),
            subscriptionId: `jbps_${'c'.repeat(64)}`,
        });
        const order: string[] = [];
        const unregisterServer = vi.fn<(id: string) => Promise<void>>(async () => {
            order.push('server');
        });
        const originalRemove = storage.removeItem.bind(storage);
        storage.removeItem = (key) => {
            order.push('metadata');
            originalRemove(key);
        };

        await expect(
            preparePushSubscriptionRegistration({
                storage,
                subscription: subscription('https://push.example/subscription/new'),
                unregisterServer,
            }),
        ).resolves.toEqual({status: 'ready', priorCleanup: 'removed'});
        expect(order).toEqual(['server', 'metadata']);
    });

    test('옛 서버 등록 제거 실패 시 새 등록으로 덮어쓰지 않도록 중단한다', async () => {
        const storage = new MemoryStorage();
        await storePushSubscriptionRegistration({
            storage,
            subscription: subscription('https://push.example/subscription/old'),
            subscriptionId: `jbps_${'d'.repeat(64)}`,
        });
        const before = storage.getItem(PUSH_SUBSCRIPTION_LIFECYCLE_STORAGE_KEY);

        await expect(
            preparePushSubscriptionRegistration({
                storage,
                subscription: subscription('https://push.example/subscription/new'),
                unregisterServer: async () => {
                    throw new Error('NETWORK_ERROR');
                },
            }),
        ).rejects.toThrow('PUSH_PREVIOUS_REGISTRATION_CLEANUP_FAILED');
        expect(storage.getItem(PUSH_SUBSCRIPTION_LIFECYCLE_STORAGE_KEY)).toBe(before);
    });
});
