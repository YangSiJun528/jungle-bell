import assert from 'node:assert/strict';

import {describe, test, vi} from 'vitest';

import {
    PUSH_SUBSCRIPTION_LIFECYCLE_STORAGE_KEY,
    cleanupPushSubscription,
    clearPushSubscriptionMetadata,
    fingerprintPushSubscriptionEndpoint,
    loadPushSubscriptionReconciliation,
    matchesPushSubscriptionEndpoint,
    readPushSubscriptionMetadata,
    reconcilePushSubscriptionState,
    writePushSubscriptionMetadata,
    type PushSubscriptionLifecycleStorage,
    type PushSubscriptionMetadata,
} from './push-subscription-lifecycle';

const subscriptionId = `jbps_${'a'.repeat(64)}`;
const endpoint = 'https://push.example.com/subscriptions/private-token';

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

async function registeredMetadata(
    overrides: Partial<PushSubscriptionMetadata> = {},
): Promise<PushSubscriptionMetadata> {
    return {
        version: 1,
        subscriptionId,
        endpointFingerprint: await fingerprintPushSubscriptionEndpoint(endpoint),
        cleanupPhase: 'registered',
        ...overrides,
    };
}

async function storeRegistered(storage: MemoryStorage): Promise<PushSubscriptionMetadata> {
    const metadata = await registeredMetadata();
    assert.deepEqual(writePushSubscriptionMetadata(storage, metadata), {status: 'written'});
    return metadata;
}

function localSubscription(localEndpoint = endpoint): PushSubscriptionJSON {
    return {
        endpoint: localEndpoint,
        expirationTime: null,
        keys: {auth: 'auth-key', p256dh: 'p256dh-key'},
    };
}

function unregisterServerMock() {
    return vi.fn<(subscriptionId: string) => Promise<void>>(async () => undefined);
}

function unsubscribeLocalMock() {
    return vi.fn<(subscription: PushSubscriptionJSON) => Promise<boolean>>(async () => true);
}

describe('push subscription metadata', () => {
    test('restores strict versioned metadata without persisting the endpoint', async () => {
        const storage = new MemoryStorage();
        const metadata = await registeredMetadata();

        assert.deepEqual(writePushSubscriptionMetadata(storage, metadata), {status: 'written'});
        assert.deepEqual(readPushSubscriptionMetadata(storage), {status: 'found', metadata});

        const serialized = storage.getItem(PUSH_SUBSCRIPTION_LIFECYCLE_STORAGE_KEY);
        assert.ok(serialized);
        assert.equal(serialized.includes(endpoint), false);
        assert.deepEqual(Object.keys(JSON.parse(serialized)).sort(), [
            'cleanupPhase',
            'endpointFingerprint',
            'subscriptionId',
            'version',
        ]);
    });

    test('matches a restored record only to the same endpoint', async () => {
        const metadata = await registeredMetadata();

        await assert.doesNotReject(async () => {
            assert.equal(
                await matchesPushSubscriptionEndpoint(localSubscription(), metadata),
                true,
            );
            assert.equal(
                await matchesPushSubscriptionEndpoint(
                    localSubscription('https://push.example.com/subscriptions/other-token'),
                    metadata,
                ),
                false,
            );
        });
        assert.match(metadata.endpointFingerprint, /^sha256:[0-9a-f]{64}$/u);
    });

    test('reconciles restart state without treating absence as verified cleanup', async () => {
        const metadata = await registeredMetadata();

        assert.deepEqual(
            await reconcilePushSubscriptionState({status: 'found', metadata}, localSubscription()),
            {status: 'matched-registered', metadata},
        );
        assert.deepEqual(
            await reconcilePushSubscriptionState(
                {
                    status: 'found',
                    metadata: {...metadata, cleanupPhase: 'server-removed'},
                },
                localSubscription(),
            ),
            {
                status: 'matched-server-removed',
                metadata: {...metadata, cleanupPhase: 'server-removed'},
            },
        );
        assert.deepEqual(
            await reconcilePushSubscriptionState({status: 'missing'}, localSubscription()),
            {status: 'local-only'},
        );
        assert.deepEqual(await reconcilePushSubscriptionState({status: 'found', metadata}, null), {
            status: 'record-only',
            metadata,
        });
        assert.deepEqual(
            await reconcilePushSubscriptionState(
                {status: 'found', metadata},
                localSubscription('https://push.example.com/subscriptions/replaced'),
            ),
            {status: 'mismatch', metadata},
        );
        assert.deepEqual(await reconcilePushSubscriptionState({status: 'missing'}, null), {
            status: 'none',
            verification: 'not-verified',
        });
    });

    test('loads the live local subscription and reconciles it with persisted metadata', async () => {
        const storage = new MemoryStorage();
        const metadata = await storeRegistered(storage);
        const getLocalSubscription = vi.fn<() => Promise<PushSubscriptionJSON>>(async () =>
            localSubscription(),
        );

        assert.deepEqual(
            await loadPushSubscriptionReconciliation({storage, getLocalSubscription}),
            {status: 'matched-registered', metadata},
        );
        assert.equal(getLocalSubscription.mock.calls.length, 1);
    });

    test('does not accept corrupt, unsupported-version, noncanonical, or expanded records', async () => {
        const storage = new MemoryStorage();
        const valid = await registeredMetadata();

        storage.setItem(PUSH_SUBSCRIPTION_LIFECYCLE_STORAGE_KEY, '{not json');
        assert.equal(readPushSubscriptionMetadata(storage).status, 'invalid');
        assert.deepEqual(readPushSubscriptionMetadata(storage), {
            status: 'invalid',
            error: {code: 'metadata-corrupt'},
        });

        storage.setItem(
            PUSH_SUBSCRIPTION_LIFECYCLE_STORAGE_KEY,
            JSON.stringify({...valid, version: 2}),
        );
        assert.deepEqual(readPushSubscriptionMetadata(storage), {
            status: 'invalid',
            error: {code: 'metadata-version-unsupported', version: 2},
        });

        for (const invalid of [
            {...valid, subscriptionId: 'jbps_short'},
            {...valid, endpointFingerprint: endpoint},
            {...valid, endpoint: 'must-not-be-stored'},
        ]) {
            storage.setItem(PUSH_SUBSCRIPTION_LIFECYCLE_STORAGE_KEY, JSON.stringify(invalid));
            assert.deepEqual(readPushSubscriptionMetadata(storage), {
                status: 'invalid',
                error: {code: 'metadata-corrupt'},
            });
        }
    });

    test('safe storage helpers report storage failures instead of claiming success', async () => {
        const failure = new Error('STORAGE_DISABLED');
        const unreadable: PushSubscriptionLifecycleStorage = {
            getItem: () => {
                throw failure;
            },
            setItem: () => {
                throw failure;
            },
            removeItem: () => {
                throw failure;
            },
        };

        assert.deepEqual(readPushSubscriptionMetadata(unreadable), {
            status: 'failed',
            error: {code: 'storage-read-failed', cause: failure},
        });
        assert.deepEqual(writePushSubscriptionMetadata(unreadable, await registeredMetadata()), {
            status: 'failed',
            error: {code: 'storage-write-failed', cause: failure},
        });
        assert.deepEqual(clearPushSubscriptionMetadata(unreadable), {
            status: 'failed',
            error: {code: 'storage-clear-failed', cause: failure},
        });
    });
});

describe('push subscription cleanup', () => {
    test('unregisters the server before unsubscribing locally and durably records the boundary', async () => {
        const events: string[] = [];
        const storage = new MemoryStorage();
        await storeRegistered(storage);
        const originalSetItem = storage.setItem.bind(storage);
        const originalRemoveItem = storage.removeItem.bind(storage);
        storage.setItem = (key, value) => {
            events.push(`write:${JSON.parse(value).cleanupPhase}`);
            originalSetItem(key, value);
        };
        storage.removeItem = (key) => {
            events.push('clear');
            originalRemoveItem(key);
        };

        const result = await cleanupPushSubscription({
            storage,
            getLocalSubscription: async () => {
                events.push('get-local');
                return localSubscription();
            },
            unregisterServer: async (id) => {
                events.push(`unregister:${id}`);
            },
            unsubscribeLocal: async (subscription) => {
                events.push(`unsubscribe:${subscription.endpoint}`);
                return true;
            },
        });

        assert.deepEqual(events, [
            'get-local',
            `unregister:${subscriptionId}`,
            'write:server-removed',
            `unsubscribe:${endpoint}`,
            'clear',
        ]);
        assert.deepEqual(result, {
            status: 'complete',
            phase: 'complete',
            progress: {metadata: 'cleared', server: 'removed', local: 'unsubscribed'},
        });
        assert.equal(readPushSubscriptionMetadata(storage).status, 'missing');
    });

    test('server failure leaves the matching local subscription and registered record intact', async () => {
        const storage = new MemoryStorage();
        const metadata = await storeRegistered(storage);
        const failure = new Error('NETWORK_ERROR');
        const unsubscribeLocal = unsubscribeLocalMock();

        const result = await cleanupPushSubscription({
            storage,
            getLocalSubscription: async () => localSubscription(),
            unregisterServer: async () => {
                throw failure;
            },
            unsubscribeLocal,
        });

        assert.deepEqual(result, {
            status: 'incomplete',
            phase: 'server-removal',
            progress: {metadata: 'registered', server: 'registered', local: 'present'},
            error: {code: 'server-unregister-failed', cause: failure},
        });
        assert.equal(unsubscribeLocal.mock.calls.length, 0);
        assert.deepEqual(readPushSubscriptionMetadata(storage), {status: 'found', metadata});
    });

    test('local failure after server success preserves the retryable server-removed phase', async () => {
        const storage = new MemoryStorage();
        await storeRegistered(storage);
        const failure = new Error('PUSH_SUBSCRIPTION_CHANGED');

        const result = await cleanupPushSubscription({
            storage,
            getLocalSubscription: async () => localSubscription(),
            unregisterServer: async () => undefined,
            unsubscribeLocal: async () => {
                throw failure;
            },
        });

        assert.deepEqual(result, {
            status: 'incomplete',
            phase: 'local-unsubscribe',
            progress: {metadata: 'server-removed', server: 'removed', local: 'present'},
            error: {code: 'local-unsubscribe-failed', cause: failure},
        });
        const restored = readPushSubscriptionMetadata(storage);
        assert.equal(restored.status, 'found');
        if (restored.status === 'found') {
            assert.equal(restored.metadata.cleanupPhase, 'server-removed');
        }
    });

    test('does not unsubscribe when the server-removed phase cannot be persisted', async () => {
        const storage = new MemoryStorage();
        const metadata = await storeRegistered(storage);
        const failure = new Error('QUOTA_EXCEEDED');
        storage.setItem = () => {
            throw failure;
        };
        const unsubscribeLocal = unsubscribeLocalMock();

        const result = await cleanupPushSubscription({
            storage,
            getLocalSubscription: async () => localSubscription(),
            unregisterServer: async () => undefined,
            unsubscribeLocal,
        });

        assert.equal(result.status, 'incomplete');
        if (result.status === 'incomplete') {
            assert.equal(result.phase, 'server-phase-persistence');
            assert.equal(result.progress.server, 'removed');
            assert.equal(result.progress.metadata, 'registered');
        }
        assert.equal(unsubscribeLocal.mock.calls.length, 0);
        assert.deepEqual(readPushSubscriptionMetadata(storage), {status: 'found', metadata});
    });

    test('retry from server-removed skips server deletion and finishes local cleanup', async () => {
        const storage = new MemoryStorage();
        await storeRegistered(storage);
        const first = await cleanupPushSubscription({
            storage,
            getLocalSubscription: async () => localSubscription(),
            unregisterServer: async () => undefined,
            unsubscribeLocal: async () => false,
        });
        assert.equal(first.status, 'incomplete');

        const unregisterServer = unregisterServerMock();
        const unsubscribeLocal = unsubscribeLocalMock();
        const retry = await cleanupPushSubscription({
            storage,
            getLocalSubscription: async () => localSubscription(),
            unregisterServer,
            unsubscribeLocal,
        });

        assert.equal(unregisterServer.mock.calls.length, 0);
        assert.equal(unsubscribeLocal.mock.calls.length, 1);
        assert.deepEqual(retry, {
            status: 'complete',
            phase: 'complete',
            progress: {metadata: 'cleared', server: 'removed', local: 'unsubscribed'},
        });
    });

    test('treats authenticated not-found as confirmed removal after a delete/write crash gap', async () => {
        const storage = new MemoryStorage();
        await storeRegistered(storage);

        const result = await cleanupPushSubscription({
            storage,
            getLocalSubscription: async () => localSubscription(),
            unregisterServer: async () => {
                throw new Error('PUSH_SUBSCRIPTION_NOT_FOUND');
            },
            unsubscribeLocal: async () => true,
        });

        assert.equal(result.status, 'complete');
        assert.equal(readPushSubscriptionMetadata(storage).status, 'missing');
    });

    test('removes a known server registration even when the local subscription is already absent', async () => {
        const storage = new MemoryStorage();
        await storeRegistered(storage);
        const unregisterServer = unregisterServerMock();
        const unsubscribeLocal = unsubscribeLocalMock();

        const result = await cleanupPushSubscription({
            storage,
            getLocalSubscription: async () => null,
            unregisterServer,
            unsubscribeLocal,
        });

        assert.equal(unregisterServer.mock.calls.length, 1);
        assert.equal(unsubscribeLocal.mock.calls.length, 0);
        assert.deepEqual(result, {
            status: 'complete',
            phase: 'complete',
            progress: {metadata: 'cleared', server: 'removed', local: 'absent'},
        });
    });

    test('does not unsubscribe or claim success when a current local subscription lacks a record', async () => {
        const storage = new MemoryStorage();
        const unregisterServer = unregisterServerMock();
        const unsubscribeLocal = unsubscribeLocalMock();

        const result = await cleanupPushSubscription({
            storage,
            getLocalSubscription: async () => localSubscription(),
            unregisterServer,
            unsubscribeLocal,
        });

        assert.deepEqual(result, {
            status: 'incomplete',
            phase: 'registration-resolution',
            progress: {metadata: 'missing', server: 'unknown', local: 'present'},
            error: {code: 'registration-id-missing'},
        });
        assert.equal(unregisterServer.mock.calls.length, 0);
        assert.equal(unsubscribeLocal.mock.calls.length, 0);
    });

    test('reports no record and no local subscription as unverified, not complete', async () => {
        const storage = new MemoryStorage();
        const unregisterServer = unregisterServerMock();
        const unsubscribeLocal = unsubscribeLocalMock();

        const result = await cleanupPushSubscription({
            storage,
            getLocalSubscription: async () => null,
            unregisterServer,
            unsubscribeLocal,
        });

        assert.deepEqual(result, {
            status: 'not-verified',
            phase: 'no-registration-record',
            reason: 'no-registration-record',
            progress: {metadata: 'missing', server: 'unknown', local: 'absent'},
        });
        assert.equal(unregisterServer.mock.calls.length, 0);
        assert.equal(unsubscribeLocal.mock.calls.length, 0);
    });

    test('does not mutate either side when the current endpoint mismatches the registration', async () => {
        const storage = new MemoryStorage();
        await storeRegistered(storage);
        const unregisterServer = unregisterServerMock();
        const unsubscribeLocal = unsubscribeLocalMock();

        const result = await cleanupPushSubscription({
            storage,
            getLocalSubscription: async () =>
                localSubscription('https://push.example.com/subscriptions/replaced'),
            unregisterServer,
            unsubscribeLocal,
        });

        assert.equal(result.status, 'incomplete');
        if (result.status === 'incomplete') {
            assert.equal(result.error.code, 'endpoint-mismatch');
        }
        assert.equal(unregisterServer.mock.calls.length, 0);
        assert.equal(unsubscribeLocal.mock.calls.length, 0);
    });

    test('a false local unsubscribe result is incomplete and remains retryable', async () => {
        const storage = new MemoryStorage();
        await storeRegistered(storage);

        const result = await cleanupPushSubscription({
            storage,
            getLocalSubscription: async () => localSubscription(),
            unregisterServer: async () => undefined,
            unsubscribeLocal: async () => false,
        });

        assert.deepEqual(result, {
            status: 'incomplete',
            phase: 'local-unsubscribe',
            progress: {metadata: 'server-removed', server: 'removed', local: 'present'},
            error: {code: 'local-unsubscribe-rejected'},
        });
    });

    test('does not complete when clearing metadata fails after both sides are removed', async () => {
        const storage = new MemoryStorage();
        await storeRegistered(storage);
        const failure = new Error('STORAGE_DISABLED');
        storage.removeItem = () => {
            throw failure;
        };

        const result = await cleanupPushSubscription({
            storage,
            getLocalSubscription: async () => localSubscription(),
            unregisterServer: async () => undefined,
            unsubscribeLocal: async () => true,
        });

        assert.equal(result.status, 'incomplete');
        if (result.status === 'incomplete') {
            assert.equal(result.phase, 'metadata-clear');
            assert.deepEqual(result.progress, {
                metadata: 'server-removed',
                server: 'removed',
                local: 'unsubscribed',
            });
        }
        const restored = readPushSubscriptionMetadata(storage);
        assert.equal(restored.status, 'found');
        if (restored.status === 'found') {
            assert.equal(restored.metadata.cleanupPhase, 'server-removed');
        }
    });

    test('corrupt metadata remains an incomplete cleanup even when no local subscription exists', async () => {
        const storage = new MemoryStorage();
        storage.setItem(PUSH_SUBSCRIPTION_LIFECYCLE_STORAGE_KEY, '{broken');
        const unregisterServer = unregisterServerMock();
        const unsubscribeLocal = unsubscribeLocalMock();

        const result = await cleanupPushSubscription({
            storage,
            getLocalSubscription: async () => null,
            unregisterServer,
            unsubscribeLocal,
        });

        assert.deepEqual(result, {
            status: 'incomplete',
            phase: 'metadata-read',
            progress: {metadata: 'invalid', server: 'unknown', local: 'absent'},
            error: {code: 'metadata-read-invalid', error: {code: 'metadata-corrupt'}},
        });
        assert.equal(unregisterServer.mock.calls.length, 0);
        assert.equal(unsubscribeLocal.mock.calls.length, 0);
    });
});
