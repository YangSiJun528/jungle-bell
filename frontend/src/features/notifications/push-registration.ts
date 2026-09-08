import {
    clearPushSubscriptionMetadata,
    fingerprintPushSubscriptionEndpoint,
    matchesPushSubscriptionEndpoint,
    readPushSubscriptionMetadata,
    writePushSubscriptionMetadata,
    type PushSubscriptionLifecycleStorage,
    type PushSubscriptionMetadata,
} from '@/api/push-subscription-lifecycle';

interface PushRegistrationStorageOptions {
    storage: PushSubscriptionLifecycleStorage;
    subscription: PushSubscriptionJSON;
}

export async function storePushSubscriptionRegistration({
    storage,
    subscription,
    subscriptionId,
}: PushRegistrationStorageOptions & {subscriptionId: string}): Promise<PushSubscriptionMetadata> {
    if (typeof subscription.endpoint !== 'string' || !subscription.endpoint) {
        throw new Error('PUSH_SUBSCRIPTION_ENDPOINT_INVALID');
    }
    const metadata: PushSubscriptionMetadata = {
        version: 1,
        subscriptionId,
        endpointFingerprint: await fingerprintPushSubscriptionEndpoint(subscription.endpoint),
        cleanupPhase: 'registered',
    };
    if (writePushSubscriptionMetadata(storage, metadata).status !== 'written') {
        throw new Error('PUSH_REGISTRATION_METADATA_WRITE_FAILED');
    }
    return metadata;
}

export async function preparePushSubscriptionRegistration({
    storage,
    subscription,
    unregisterServer,
}: PushRegistrationStorageOptions & {
    unregisterServer: (subscriptionId: string) => Promise<void>;
}): Promise<{
    status: 'ready';
    priorCleanup: 'not-needed' | 'removed' | 'unverified';
}> {
    const stored = readPushSubscriptionMetadata(storage);
    if (stored.status === 'failed') throw new Error('PUSH_REGISTRATION_METADATA_READ_FAILED');
    if (stored.status === 'invalid') {
        assertMetadataCleared(storage);
        return {status: 'ready', priorCleanup: 'unverified'};
    }
    if (stored.status === 'missing') {
        return {status: 'ready', priorCleanup: 'not-needed'};
    }
    if (await matchesPushSubscriptionEndpoint(subscription, stored.metadata)) {
        return {status: 'ready', priorCleanup: 'not-needed'};
    }

    if (stored.metadata.cleanupPhase === 'registered') {
        try {
            await unregisterServer(stored.metadata.subscriptionId);
        } catch (error) {
            if (!(error instanceof Error && error.message === 'PUSH_SUBSCRIPTION_NOT_FOUND')) {
                throw new Error('PUSH_PREVIOUS_REGISTRATION_CLEANUP_FAILED', {cause: error});
            }
        }
    }
    assertMetadataCleared(storage);
    return {status: 'ready', priorCleanup: 'removed'};
}

function assertMetadataCleared(storage: PushSubscriptionLifecycleStorage): void {
    if (clearPushSubscriptionMetadata(storage).status !== 'cleared') {
        throw new Error('PUSH_REGISTRATION_METADATA_CLEAR_FAILED');
    }
}
