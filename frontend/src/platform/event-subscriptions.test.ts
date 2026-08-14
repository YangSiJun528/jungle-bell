import assert from 'node:assert/strict';
import {test} from 'vitest';
import {
    createDesktopSubscriptionRegistry,
    disposeDesktopSubscriptions,
    registerDesktopSubscriptions,
} from './event-subscriptions';

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return {promise, resolve, reject};
}

test('desktop event listeners start concurrently and clean up after normal registration', async () => {
    const registrations = [deferred<() => void>(), deferred<() => void>(), deferred<() => void>()];
    const starts: number[] = [];
    const cleanupCounts = [0, 0, 0];
    let readyCount = 0;
    const registry = createDesktopSubscriptionRegistry();

    const registration = registerDesktopSubscriptions(
        registry,
        registrations.map((entry, index) => () => {
            starts.push(index);
            return entry.promise;
        }),
        async () => { readyCount += 1; },
    );

    assert.deepEqual(starts, [0, 1, 2]);
    registrations.forEach((entry, index) => entry.resolve(() => {
        cleanupCounts[index] = (cleanupCounts[index] ?? 0) + 1;
    }));
    await registration;
    assert.equal(readyCount, 1);

    disposeDesktopSubscriptions(registry);
    assert.deepEqual(cleanupCounts, [1, 1, 1]);
});

test('desktop event listeners resolving after disposal are immediately removed without reporting ready', async () => {
    const registrations = [deferred<() => void>(), deferred<() => void>(), deferred<() => void>()];
    const cleanupCounts = [0, 0, 0];
    let readyCount = 0;
    const registry = createDesktopSubscriptionRegistry();

    const registration = registerDesktopSubscriptions(
        registry,
        registrations.map((entry) => () => entry.promise),
        async () => { readyCount += 1; },
    );
    disposeDesktopSubscriptions(registry);
    registrations.forEach((entry, index) => entry.resolve(() => {
        cleanupCounts[index] = (cleanupCounts[index] ?? 0) + 1;
    }));
    await registration;

    assert.equal(readyCount, 0);
    assert.deepEqual(cleanupCounts, [1, 1, 1]);
});

test('partial listener registration is rolled back when one registration fails', async () => {
    const cleanupCounts = [0, 0];
    const registry = createDesktopSubscriptionRegistry();

    await assert.rejects(
        registerDesktopSubscriptions(
            registry,
            [
                async () => () => { cleanupCounts[0] = (cleanupCounts[0] ?? 0) + 1; },
                async () => { throw new Error('LISTEN_FAILED'); },
                async () => () => { cleanupCounts[1] = (cleanupCounts[1] ?? 0) + 1; },
            ],
            async () => { throw new Error('READY_MUST_NOT_RUN'); },
        ),
        /LISTEN_FAILED/,
    );
    assert.deepEqual(cleanupCounts, [1, 1]);
});
