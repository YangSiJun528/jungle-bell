import {z} from 'zod';

import type {PushState} from './status-model';

export const NOTIFICATION_TEST_QUERY_KEY = ['notification-test-result'] as const;
export const NOTIFICATION_TEST_STORAGE_KEY = 'jungle-bell.notification-test-result';

const testStateSchema = z.discriminatedUnion('status', [
    z.strictObject({status: z.literal('test-sending')}),
    z.strictObject({status: z.literal('arrived')}),
    z.strictObject({status: z.literal('not-arrived')}),
    z.strictObject({status: z.literal('error')}),
]);

const notificationTestRecordSchema = z.strictObject({
    version: z.literal(1),
    surface: z.enum(['pc', 'pwa']),
    state: testStateSchema,
    testedAt: z.iso.datetime(),
});

export type NotificationTestState = Extract<
    PushState,
    {status: 'test-sending' | 'arrived' | 'not-arrived' | 'error'}
>;

export interface NotificationTestRecord {
    version: 1;
    surface: 'pc' | 'pwa';
    state: NotificationTestState;
    testedAt: string;
}

export interface NotificationTestStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
}

export function readNotificationTestRecord(
    storage: NotificationTestStorage,
): NotificationTestRecord | null {
    try {
        const serialized = storage.getItem(NOTIFICATION_TEST_STORAGE_KEY);
        if (serialized === null) return null;
        const parsed = notificationTestRecordSchema.safeParse(JSON.parse(serialized));
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

export function writeNotificationTestRecord(
    storage: NotificationTestStorage,
    input: Omit<NotificationTestRecord, 'version'>,
): NotificationTestRecord {
    const record = notificationTestRecordSchema.parse({version: 1, ...input});
    storage.setItem(NOTIFICATION_TEST_STORAGE_KEY, JSON.stringify(record));
    return record;
}
