import {z} from 'zod';

import {pushSubscriptionIdSchema} from './dashboard-account-contract';

export const PUSH_SUBSCRIPTION_LIFECYCLE_STORAGE_KEY = 'jungle-bell.push-subscription-lifecycle';
export const PUSH_SUBSCRIPTION_METADATA_VERSION = 1 as const;
export const PUSH_SUBSCRIPTION_LIFECYCLE_QUERY_KEY = ['push-subscription-lifecycle'] as const;

const endpointFingerprintSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);

export const pushSubscriptionMetadataSchema = z.strictObject({
    version: z.literal(PUSH_SUBSCRIPTION_METADATA_VERSION),
    subscriptionId: pushSubscriptionIdSchema,
    endpointFingerprint: endpointFingerprintSchema,
    cleanupPhase: z.enum(['registered', 'server-removed']),
});

export type PushSubscriptionMetadata = z.infer<typeof pushSubscriptionMetadataSchema>;

export interface PushSubscriptionLifecycleStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}

export type PushSubscriptionMetadataInvalidError =
    | {code: 'metadata-corrupt'}
    | {code: 'metadata-version-unsupported'; version: unknown};

export type PushSubscriptionMetadataStorageError =
    | {code: 'storage-read-failed'; cause: unknown}
    | {code: 'storage-write-failed'; cause: unknown}
    | {code: 'storage-clear-failed'; cause: unknown};

export type PushSubscriptionMetadataReadResult =
    | {status: 'found'; metadata: PushSubscriptionMetadata}
    | {status: 'missing'}
    | {status: 'invalid'; error: PushSubscriptionMetadataInvalidError}
    | {
          status: 'failed';
          error: Extract<PushSubscriptionMetadataStorageError, {code: 'storage-read-failed'}>;
      };

export type PushSubscriptionMetadataWriteResult =
    | {status: 'written'}
    | {status: 'invalid'; error: {code: 'metadata-invalid'}}
    | {
          status: 'failed';
          error: Extract<PushSubscriptionMetadataStorageError, {code: 'storage-write-failed'}>;
      };

export type PushSubscriptionMetadataClearResult =
    | {status: 'cleared'}
    | {
          status: 'failed';
          error: Extract<PushSubscriptionMetadataStorageError, {code: 'storage-clear-failed'}>;
      };

export function readPushSubscriptionMetadata(
    storage: PushSubscriptionLifecycleStorage,
): PushSubscriptionMetadataReadResult {
    let serialized: string | null;
    try {
        serialized = storage.getItem(PUSH_SUBSCRIPTION_LIFECYCLE_STORAGE_KEY);
    } catch (cause) {
        return {status: 'failed', error: {code: 'storage-read-failed', cause}};
    }

    if (serialized === null) return {status: 'missing'};

    let value: unknown;
    try {
        value = JSON.parse(serialized);
    } catch {
        return {status: 'invalid', error: {code: 'metadata-corrupt'}};
    }

    if (!isRecord(value) || !Object.hasOwn(value, 'version')) {
        return {status: 'invalid', error: {code: 'metadata-corrupt'}};
    }
    if (value.version !== PUSH_SUBSCRIPTION_METADATA_VERSION) {
        return {
            status: 'invalid',
            error: {code: 'metadata-version-unsupported', version: value.version},
        };
    }

    const parsed = pushSubscriptionMetadataSchema.safeParse(value);
    if (!parsed.success) {
        return {status: 'invalid', error: {code: 'metadata-corrupt'}};
    }
    return {status: 'found', metadata: parsed.data};
}

export function writePushSubscriptionMetadata(
    storage: PushSubscriptionLifecycleStorage,
    metadata: unknown,
): PushSubscriptionMetadataWriteResult {
    const parsed = pushSubscriptionMetadataSchema.safeParse(metadata);
    if (!parsed.success) return {status: 'invalid', error: {code: 'metadata-invalid'}};

    try {
        storage.setItem(PUSH_SUBSCRIPTION_LIFECYCLE_STORAGE_KEY, JSON.stringify(parsed.data));
        return {status: 'written'};
    } catch (cause) {
        return {status: 'failed', error: {code: 'storage-write-failed', cause}};
    }
}

export function clearPushSubscriptionMetadata(
    storage: PushSubscriptionLifecycleStorage,
): PushSubscriptionMetadataClearResult {
    try {
        storage.removeItem(PUSH_SUBSCRIPTION_LIFECYCLE_STORAGE_KEY);
        return {status: 'cleared'};
    } catch (cause) {
        return {status: 'failed', error: {code: 'storage-clear-failed', cause}};
    }
}

export type PushSubscriptionDigest = Pick<SubtleCrypto, 'digest'>;

export async function fingerprintPushSubscriptionEndpoint(
    endpoint: string,
    subtleCrypto?: PushSubscriptionDigest,
): Promise<string> {
    if (!endpoint) throw new Error('PUSH_SUBSCRIPTION_ENDPOINT_INVALID');
    const digestProvider = subtleCrypto ?? globalThis.crypto?.subtle;
    if (!digestProvider) throw new Error('PUSH_SUBSCRIPTION_CRYPTO_UNAVAILABLE');

    const digest = await digestProvider.digest('SHA-256', new TextEncoder().encode(endpoint));
    const hexadecimal = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, '0'),
    ).join('');
    return `sha256:${hexadecimal}`;
}

export async function matchesPushSubscriptionEndpoint(
    subscription: Pick<PushSubscriptionJSON, 'endpoint'>,
    metadata: Pick<PushSubscriptionMetadata, 'endpointFingerprint'>,
    subtleCrypto?: PushSubscriptionDigest,
): Promise<boolean> {
    if (
        typeof subscription.endpoint !== 'string' ||
        !subscription.endpoint ||
        !endpointFingerprintSchema.safeParse(metadata.endpointFingerprint).success
    ) {
        return false;
    }
    return (
        (await fingerprintPushSubscriptionEndpoint(subscription.endpoint, subtleCrypto)) ===
        metadata.endpointFingerprint
    );
}

export type PushSubscriptionReconciliation =
    | {status: 'matched-registered'; metadata: PushSubscriptionMetadata}
    | {status: 'matched-server-removed'; metadata: PushSubscriptionMetadata}
    | {status: 'local-only'}
    | {status: 'record-only'; metadata: PushSubscriptionMetadata}
    | {status: 'mismatch'; metadata: PushSubscriptionMetadata}
    | {status: 'none'; verification: 'not-verified'}
    | {status: 'invalid'; error: PushSubscriptionMetadataInvalidError}
    | {
          status: 'failed';
          error:
              | Extract<PushSubscriptionMetadataStorageError, {code: 'storage-read-failed'}>
              | {code: 'endpoint-verification-failed'; cause: unknown};
      };

export async function reconcilePushSubscriptionState(
    metadataResult: PushSubscriptionMetadataReadResult,
    localSubscription: PushSubscriptionJSON | null,
    subtleCrypto?: PushSubscriptionDigest,
): Promise<PushSubscriptionReconciliation> {
    if (metadataResult.status === 'failed' || metadataResult.status === 'invalid') {
        return metadataResult;
    }
    if (metadataResult.status === 'missing') {
        return localSubscription
            ? {status: 'local-only'}
            : {status: 'none', verification: 'not-verified'};
    }
    if (!localSubscription) {
        return {status: 'record-only', metadata: metadataResult.metadata};
    }

    let matches: boolean;
    try {
        matches = await matchesPushSubscriptionEndpoint(
            localSubscription,
            metadataResult.metadata,
            subtleCrypto,
        );
    } catch (cause) {
        return {status: 'failed', error: {code: 'endpoint-verification-failed', cause}};
    }
    if (!matches) return {status: 'mismatch', metadata: metadataResult.metadata};
    return metadataResult.metadata.cleanupPhase === 'registered'
        ? {status: 'matched-registered', metadata: metadataResult.metadata}
        : {status: 'matched-server-removed', metadata: metadataResult.metadata};
}

export async function loadPushSubscriptionReconciliation(options: {
    storage: PushSubscriptionLifecycleStorage;
    getLocalSubscription(): Promise<PushSubscriptionJSON | null>;
    subtleCrypto?: PushSubscriptionDigest;
}): Promise<PushSubscriptionReconciliation> {
    const localSubscription = await options.getLocalSubscription();
    return reconcilePushSubscriptionState(
        readPushSubscriptionMetadata(options.storage),
        localSubscription,
        options.subtleCrypto,
    );
}

export type PushSubscriptionCleanupProgress = {
    metadata: 'unknown' | 'missing' | 'invalid' | 'registered' | 'server-removed' | 'cleared';
    server: 'unknown' | 'registered' | 'removed';
    local: 'unknown' | 'absent' | 'present' | 'unsubscribed';
};

export type PushSubscriptionCleanupError =
    | {code: 'local-subscription-query-failed'; cause: unknown}
    | {code: 'metadata-read-invalid'; error: PushSubscriptionMetadataInvalidError}
    | {
          code: 'metadata-read-failed';
          error: Extract<PushSubscriptionMetadataStorageError, {code: 'storage-read-failed'}>;
      }
    | {code: 'registration-id-missing'}
    | {code: 'endpoint-mismatch'}
    | {code: 'endpoint-verification-failed'; cause: unknown}
    | {code: 'server-unregister-failed'; cause: unknown}
    | {code: 'server-phase-persist-failed'; error: PushSubscriptionMetadataWriteResult}
    | {code: 'local-unsubscribe-rejected'}
    | {code: 'local-unsubscribe-failed'; cause: unknown}
    | {code: 'metadata-clear-failed'; error: PushSubscriptionMetadataClearResult};

export type PushSubscriptionCleanupResult =
    | {
          status: 'complete';
          phase: 'complete';
          progress: PushSubscriptionCleanupProgress;
      }
    | {
          status: 'not-verified';
          phase: 'no-registration-record';
          reason: 'no-registration-record';
          progress: PushSubscriptionCleanupProgress;
      }
    | {
          status: 'incomplete';
          phase:
              | 'local-query'
              | 'metadata-read'
              | 'registration-resolution'
              | 'endpoint-verification'
              | 'server-removal'
              | 'server-phase-persistence'
              | 'local-unsubscribe'
              | 'metadata-clear';
          progress: PushSubscriptionCleanupProgress;
          error: PushSubscriptionCleanupError;
      };

export interface CleanupPushSubscriptionOptions {
    storage: PushSubscriptionLifecycleStorage;
    getLocalSubscription(): Promise<PushSubscriptionJSON | null>;
    unregisterServer(subscriptionId: string): Promise<void>;
    unsubscribeLocal(subscription: PushSubscriptionJSON): Promise<boolean>;
    subtleCrypto?: PushSubscriptionDigest;
}

export async function cleanupPushSubscription(
    options: CleanupPushSubscriptionOptions,
): Promise<PushSubscriptionCleanupResult> {
    let localSubscription: PushSubscriptionJSON | null;
    try {
        localSubscription = await options.getLocalSubscription();
    } catch (cause) {
        return incomplete(
            'local-query',
            {metadata: 'unknown', server: 'unknown', local: 'unknown'},
            {code: 'local-subscription-query-failed', cause},
        );
    }

    const metadataResult = readPushSubscriptionMetadata(options.storage);
    const reconciliation = await reconcilePushSubscriptionState(
        metadataResult,
        localSubscription,
        options.subtleCrypto,
    );

    if (reconciliation.status === 'invalid') {
        return incomplete(
            'metadata-read',
            {
                metadata: 'invalid',
                server: 'unknown',
                local: localSubscription ? 'present' : 'absent',
            },
            {code: 'metadata-read-invalid', error: reconciliation.error},
        );
    }
    if (reconciliation.status === 'failed') {
        const progress: PushSubscriptionCleanupProgress = {
            metadata:
                reconciliation.error.code === 'storage-read-failed'
                    ? 'unknown'
                    : metadataResult.status === 'found'
                      ? metadataResult.metadata.cleanupPhase
                      : 'unknown',
            server:
                metadataResult.status === 'found'
                    ? metadataResult.metadata.cleanupPhase === 'server-removed'
                        ? 'removed'
                        : 'registered'
                    : 'unknown',
            local: localSubscription ? 'present' : 'absent',
        };
        return reconciliation.error.code === 'storage-read-failed'
            ? incomplete('metadata-read', progress, {
                  code: 'metadata-read-failed',
                  error: reconciliation.error,
              })
            : incomplete('endpoint-verification', progress, reconciliation.error);
    }
    if (reconciliation.status === 'local-only') {
        return incomplete(
            'registration-resolution',
            {metadata: 'missing', server: 'unknown', local: 'present'},
            {code: 'registration-id-missing'},
        );
    }
    if (reconciliation.status === 'none') {
        return {
            status: 'not-verified',
            phase: 'no-registration-record',
            reason: 'no-registration-record',
            progress: {metadata: 'missing', server: 'unknown', local: 'absent'},
        };
    }
    if (reconciliation.status === 'mismatch') {
        return incomplete(
            'endpoint-verification',
            {
                metadata: reconciliation.metadata.cleanupPhase,
                server:
                    reconciliation.metadata.cleanupPhase === 'server-removed'
                        ? 'removed'
                        : 'registered',
                local: 'present',
            },
            {code: 'endpoint-mismatch'},
        );
    }

    const metadata = reconciliation.metadata;
    let progress: PushSubscriptionCleanupProgress = {
        metadata: metadata.cleanupPhase,
        server: metadata.cleanupPhase === 'server-removed' ? 'removed' : 'registered',
        local: localSubscription ? 'present' : 'absent',
    };

    if (metadata.cleanupPhase === 'registered') {
        try {
            await options.unregisterServer(metadata.subscriptionId);
        } catch (cause) {
            if (!serverRegistrationAlreadyAbsent(cause)) {
                return incomplete('server-removal', progress, {
                    code: 'server-unregister-failed',
                    cause,
                });
            }
        }
        progress = {...progress, server: 'removed'};

        const phaseWrite = writePushSubscriptionMetadata(options.storage, {
            ...metadata,
            cleanupPhase: 'server-removed',
        });
        if (phaseWrite.status !== 'written') {
            return incomplete('server-phase-persistence', progress, {
                code: 'server-phase-persist-failed',
                error: phaseWrite,
            });
        }
        progress = {...progress, metadata: 'server-removed'};
    }

    if (localSubscription) {
        let unsubscribed: boolean;
        try {
            unsubscribed = await options.unsubscribeLocal(localSubscription);
        } catch (cause) {
            return incomplete('local-unsubscribe', progress, {
                code: 'local-unsubscribe-failed',
                cause,
            });
        }
        if (!unsubscribed) {
            return incomplete('local-unsubscribe', progress, {
                code: 'local-unsubscribe-rejected',
            });
        }
        progress = {...progress, local: 'unsubscribed'};
    }

    const cleared = clearPushSubscriptionMetadata(options.storage);
    if (cleared.status !== 'cleared') {
        return incomplete('metadata-clear', progress, {
            code: 'metadata-clear-failed',
            error: cleared,
        });
    }

    return {
        status: 'complete',
        phase: 'complete',
        progress: {...progress, metadata: 'cleared'},
    };
}

function incomplete(
    phase: Extract<PushSubscriptionCleanupResult, {status: 'incomplete'}>['phase'],
    progress: PushSubscriptionCleanupProgress,
    error: PushSubscriptionCleanupError,
): Extract<PushSubscriptionCleanupResult, {status: 'incomplete'}> {
    return {status: 'incomplete', phase, progress, error};
}

function serverRegistrationAlreadyAbsent(error: unknown): boolean {
    return error instanceof Error && error.message === 'PUSH_SUBSCRIPTION_NOT_FOUND';
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
