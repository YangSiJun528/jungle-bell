import {z} from 'zod';

import {normalizeManualPairingCode} from '@/domain/connections/manual-pairing-code';
import {
    normalizeNotificationInboxSnapshot,
    type NotificationInboxSnapshot,
} from '@/domain/notifications/inbox';

import {parseResponse} from './api-response';
import {
    calendarDateSchema,
    isoDateTimeSchema,
    safeEpochMillisecondsSchema,
    textSchema,
} from './dashboard-contract-shared';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';

export const pairingIdSchema = z
    .string()
    .max(64)
    .regex(new RegExp(`^jbp_${UUID}$`, 'u'));
export const claimIdSchema = pairingIdSchema;
export const pairingChallengeSchema = z.string().regex(/^jbpc_[0-9a-f]{64}$/u);
export const uuidIdentifierSchema = z
    .string()
    .max(36)
    .regex(new RegExp(`^${UUID}$`, 'u'));
export const pushSubscriptionIdSchema = z
    .string()
    .max(69)
    .regex(/^jbps_[0-9a-f]{64}$/u);
export const mobileInstallationIdSchema = z
    .string()
    .max(37)
    .regex(/^jbmi_[0-9a-f]{32}$/u);
export const mobileSessionIdSchema = z
    .string()
    .max(64)
    .regex(new RegExp(`^jbsi_${UUID}$`, 'u'));
export const notificationInboxIdSchema = z.string().regex(/^\d+$/u);

const canonicalTextSchema = (maximum: number) =>
    textSchema(maximum).refine((value) => value.trim() === value, '앞뒤 공백은 허용되지 않습니다.');

export const attendanceSnapshotSchema = z
    .strictObject({
        attendanceDate: calendarDateSchema,
        cohortId: textSchema(128).nullable(),
        cohortStatus: z.enum(['active', 'upcoming', 'ended', 'none', 'unknown']),
        cohortStartDate: calendarDateSchema.nullable(),
        cohortEndDate: calendarDateSchema.nullable(),
        morningChecked: z.boolean(),
        eveningChecked: z.boolean(),
        collectedAt: isoDateTimeSchema,
    })
    .superRefine((value, context) => {
        const invalid =
            (value.cohortStartDate !== null &&
                value.cohortEndDate !== null &&
                value.cohortStartDate > value.cohortEndDate) ||
            (value.cohortStatus === 'active' && value.cohortId === null) ||
            ((value.cohortStatus === 'upcoming' || value.cohortStatus === 'ended') &&
                (value.cohortId !== null || value.morningChecked || value.eveningChecked)) ||
            (value.cohortStatus === 'none' &&
                (value.cohortId !== null ||
                    value.cohortStartDate !== null ||
                    value.cohortEndDate !== null ||
                    value.morningChecked ||
                    value.eveningChecked)) ||
            (value.cohortStatus === 'unknown' && value.cohortId !== null);
        if (invalid) {
            context.addIssue({
                code: 'custom',
                message: '출석 기수 상태 불변식이 올바르지 않습니다.',
            });
        }
    });

export interface AttendanceSnapshot {
    attendanceDate: string;
    cohortId: string | null;
    cohortStatus: string;
    cohortStartDate: string | null;
    cohortEndDate: string | null;
    morningChecked: boolean;
    eveningChecked: boolean;
    collectedAt: string;
}

export type AttendanceData =
    | {
          status: 'available';
          freshness: 'fresh' | 'stale';
          lastSyncedAt: string;
          snapshot: AttendanceSnapshot;
          source?: 'server' | 'desktop';
          syncState?: 'synced' | 'pending';
      }
    | {
          status: 'unavailable';
          freshness: 'missing';
          lastSyncedAt: null;
          snapshot: null;
      };

const desktopDeviceSchema = z.strictObject({
    id: textSchema(128),
    deviceLabel: textSchema(80).nullable(),
    lastSeenAt: isoDateTimeSchema.nullable(),
    lmsSessionState: z.enum(['unknown', 'connected', 'login-required']),
    health: z.enum(['unknown', 'online', 'offline']),
    appVersion: textSchema(64).nullable(),
});

export type DesktopDevice = z.infer<typeof desktopDeviceSchema>;

const attendanceDashboardPayloadSchema = z
    .strictObject({
        attendance: attendanceSnapshotSchema.nullable(),
        freshness: z.enum(['fresh', 'stale', 'missing']),
        devices: z.array(desktopDeviceSchema).max(32),
    })
    .superRefine((value, context) => {
        if ((value.attendance === null) !== (value.freshness === 'missing')) {
            context.addIssue({
                code: 'custom',
                message: '출석 데이터와 freshness가 일치하지 않습니다.',
            });
        }
    });

export interface AttendanceDashboardPayload {
    attendance: AttendanceData;
    devices: DesktopDevice[];
}

export function parseAttendanceDashboardPayload(value: unknown): AttendanceDashboardPayload {
    const parsed = parseResponse(attendanceDashboardPayloadSchema, value);
    return {
        attendance:
            parsed.attendance === null
                ? {status: 'unavailable', freshness: 'missing', lastSyncedAt: null, snapshot: null}
                : {
                      status: 'available',
                      freshness: parsed.freshness as 'fresh' | 'stale',
                      lastSyncedAt: parsed.attendance.collectedAt,
                      snapshot: parsed.attendance,
                      source: 'server',
                      syncState: 'synced',
                  },
        devices: parsed.devices,
    };
}

const desktopConnectionWireSchema = z.strictObject({
    authenticated: z.boolean(),
    credentialPersistent: z.boolean(),
    identityResetRequired: z.boolean(),
    lmsSessionState: z.enum(['unknown', 'connected', 'login-required']),
    lastServerContact: isoDateTimeSchema.nullable(),
    lastError: textSchema(128).nullable(),
});

export interface DesktopConnectionState {
    state: 'disconnected' | 'unknown' | 'connected' | 'reset-required';
    credentialPersistent: boolean;
    lastVerifiedAt: string | null;
    lastSeenAt: string | null;
    health: 'unknown' | 'online' | 'offline' | null;
    lmsSessionState: 'unknown' | 'connected' | 'login-required';
}

export function parseDesktopConnection(value: unknown): DesktopConnectionState {
    const parsed = parseResponse(desktopConnectionWireSchema, value);
    return {
        state: parsed.identityResetRequired
            ? 'reset-required'
            : parsed.authenticated
              ? 'connected'
              : 'disconnected',
        credentialPersistent: parsed.credentialPersistent,
        lastVerifiedAt: parsed.lastServerContact,
        lastSeenAt: parsed.lastServerContact,
        health: parsed.authenticated ? (parsed.lastError === null ? 'online' : 'unknown') : null,
        lmsSessionState: parsed.lmsSessionState,
    };
}

const manualPairingCodeSchema = z
    .string()
    .min(1)
    .max(32)
    .transform(normalizeManualPairingCode)
    .pipe(z.string().regex(/^[0-9A-HJKMNP-TV-Z]{10}$/u));

export const mobilePairingCreatedSchema = z.strictObject({
    pairingId: pairingIdSchema,
    qrPayload: textSchema(4_096),
    manualCode: manualPairingCodeSchema,
    expiresAt: isoDateTimeSchema,
});

export type MobilePairingCreated = z.infer<typeof mobilePairingCreatedSchema>;

export const pairingClaimSchema = z.strictObject({
    claimId: claimIdSchema,
    status: z.literal('awaiting-desktop-approval'),
});

export type PairingClaim = z.infer<typeof pairingClaimSchema>;

const pairingClaimDetailsSchema = z.strictObject({
    claimId: claimIdSchema,
    deviceLabel: textSchema(80),
    confirmationCode: z.string().regex(/^[A-Za-z0-9]{4}$/u),
});

export const mobilePairingStatusSchema = z.discriminatedUnion('status', [
    z.strictObject({
        status: z.literal('claimed'),
        claim: pairingClaimDetailsSchema,
    }),
    z.strictObject({
        status: z.enum(['pending', 'approved', 'completed', 'expired']),
        claim: z.null(),
    }),
]);

export type MobilePairingStatus = z.infer<typeof mobilePairingStatusSchema>;

const mobileSessionSchema = z
    .strictObject({
        deviceId: mobileSessionIdSchema,
        deviceLabel: textSchema(80),
        installationId: mobileInstallationIdSchema,
        createdAt: isoDateTimeSchema,
        expiresAt: isoDateTimeSchema,
        lastSeenAt: isoDateTimeSchema,
        pushEnabled: z.boolean(),
        status: z.enum(['active', 'revoked', 'expired']),
    })
    .refine(
        (value) =>
            Date.parse(value.expiresAt) > Date.parse(value.createdAt) &&
            Date.parse(value.lastSeenAt) >= Date.parse(value.createdAt),
        '모바일 세션 시간 순서가 올바르지 않습니다.',
    );

export const mobileSessionsSchema = z.strictObject({
    devices: z.array(mobileSessionSchema).max(128),
});

export type MobileSession = z.infer<typeof mobileSessionSchema>;

const notificationPathSchema = z
    .string()
    .min(1)
    .max(128)
    .regex(/^\/#\/?(?:attendance|laundry|meals|notifications|connections)$/u)
    .transform((path) => path.replace(/^\/#\/?/u, '/#/'));

const notificationKindSchema = z
    .enum([
        'meal-published',
        'laundry-finishing',
        'laundry-completion-expected',
        'laundry-completed',
        'laundry-available',
        'laundry-attention',
        'attendance-action-required',
        'attendance-morning',
        'attendance-evening',
        'login-required',
        'test',
    ])
    .transform((kind) =>
        kind === 'attendance-morning' || kind === 'attendance-evening'
            ? ('attendance-action-required' as const)
            : kind,
    );

const dashboardNotificationSchema = z
    .strictObject({
        id: uuidIdentifierSchema,
        kind: notificationKindSchema,
        title: textSchema(256),
        body: textSchema(2_048),
        path: notificationPathSchema,
        createdAtEpochMs: safeEpochMillisecondsSchema,
        expiresAtEpochMs: safeEpochMillisecondsSchema,
        attempt: z.number().int().min(0).max(1_000),
    })
    .refine(
        (value) => value.expiresAtEpochMs >= value.createdAtEpochMs,
        '알림 만료 시각이 생성 시각보다 빨라서는 안 됩니다.',
    );

export const dashboardNotificationsSchema = z.strictObject({
    notifications: z.array(dashboardNotificationSchema).max(128),
});

export interface DashboardNotification {
    id: string;
    kind: string;
    title: string;
    body: string;
    path: string;
    createdAtEpochMs: number;
    expiresAtEpochMs: number;
    attempt: number;
}

export const browserAccountSessionSchema = z.strictObject({
    authenticated: z.literal(true),
    expiresAt: isoDateTimeSchema,
});

export type BrowserAccountSession = z.infer<typeof browserAccountSessionSchema>;

const notificationInboxSnapshotSchema = z.unknown().transform((value, context) => {
    const snapshot = normalizeNotificationInboxSnapshot(value);
    if (!snapshot) {
        context.addIssue({code: 'custom', message: '알림함 snapshot이 올바르지 않습니다.'});
        return z.NEVER;
    }
    return snapshot;
});

export function parseNotificationInboxSnapshot(value: unknown): NotificationInboxSnapshot {
    return parseResponse(notificationInboxSnapshotSchema, value);
}

export const desktopTestNotificationResultSchema = z.strictObject({
    snapshot: notificationInboxSnapshotSchema,
    systemDelivered: z.boolean(),
    mobileQueued: z.number().int().min(0).max(100).nullable(),
});

export interface DesktopTestNotificationResult {
    snapshot: NotificationInboxSnapshot;
    systemDelivered: boolean;
    mobileQueued: number | null;
}

export function parseDesktopTestNotificationResult(value: unknown): DesktopTestNotificationResult {
    return parseResponse(desktopTestNotificationResultSchema, value);
}

export const mobileTestNotificationResultSchema = z.strictObject({
    notificationId: uuidIdentifierSchema,
    queued: z.number().int().min(1),
});

export const pushPublicKeyResultSchema = z.strictObject({
    publicKey: z.string().regex(/^B[A-Za-z0-9_-]{86}$/u),
});

export const pushSubscriptionResultSchema = z.strictObject({
    subscriptionId: pushSubscriptionIdSchema,
});

export const manualPairingClaimInputSchema = z.strictObject({
    manualCode: manualPairingCodeSchema,
    deviceLabel: canonicalTextSchema(80),
    installationId: mobileInstallationIdSchema,
});

export const qrPairingClaimInputSchema = z.strictObject({
    pairingId: pairingIdSchema,
    challenge: pairingChallengeSchema,
    deviceLabel: canonicalTextSchema(80),
    installationId: mobileInstallationIdSchema,
});

export const qrPairingHandoffInputSchema = qrPairingClaimInputSchema.pick({
    pairingId: true,
    challenge: true,
});

export const pairingHandoffClaimInputSchema = qrPairingClaimInputSchema.pick({
    deviceLabel: true,
    installationId: true,
});

export const pushSubscriptionInputSchema = z.strictObject({
    endpoint: textSchema(4_096),
    keys: z.strictObject({
        p256dh: textSchema(4_096),
        auth: textSchema(4_096),
    }),
});
