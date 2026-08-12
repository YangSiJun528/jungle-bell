import {z} from 'zod';

const canonicalString = (maximum: number) => z.string()
    .min(1)
    .max(maximum)
    .refine((value) => value.trim() === value, '앞뒤 공백은 허용되지 않습니다.');
const epochMillisecondsSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const attendancePreferencesSchema = z.strictObject({
    morning: z.boolean(),
    evening: z.boolean(),
    skipSunday: z.boolean(),
    skipAttendanceDate: z.iso.date().nullable(),
});

export const mealPreferencesInputSchema = z.strictObject({
    enabled: z.boolean(),
    breakfast: z.boolean(),
    lunch: z.boolean(),
    dinner: z.boolean(),
});

export const mealPreferencesSchema = mealPreferencesInputSchema.extend({
    updatedAtEpochMs: epochMillisecondsSchema,
});

export const laundryApplianceSchema = z.enum(['washer', 'dryer']);

export const laundryWatchInputSchema = z.strictObject({
    machineId: canonicalString(128),
    appliance: laundryApplianceSchema,
    sessionId: canonicalString(256).nullable(),
    notifyBeforeMinutes: z.number().int().min(0).max(180),
    notifyWhenAvailable: z.boolean(),
});

export const laundryWatchIdSchema = z.string().regex(/^jbw_[a-f0-9]{64}$/u);
export const laundryWatchSchema = laundryWatchInputSchema.extend({
    id: laundryWatchIdSchema,
    status: z.enum(['active', 'completed', 'cancelled']),
    createdAtEpochMs: epochMillisecondsSchema,
    updatedAtEpochMs: epochMillisecondsSchema,
}).refine(
    (value) => value.updatedAtEpochMs >= value.createdAtEpochMs,
    {message: 'updatedAtEpochMs must not precede createdAtEpochMs'},
);

export const laundryWatchListSchema = z.strictObject({
    watches: z.array(laundryWatchSchema).max(128),
});

export const laundryQueueInputSchema = z.strictObject({
    machineId: canonicalString(128).nullable(),
    appliance: laundryApplianceSchema,
});

export const laundryQueueIdSchema = z.string().regex(/^jbq_[a-f0-9]{64}$/u);
export const laundryQueueEntrySchema = laundryQueueInputSchema.extend({
    id: laundryQueueIdSchema,
    status: z.enum(['waiting', 'claimed', 'cancelled', 'expired']),
    joinedAtEpochMs: epochMillisecondsSchema,
    leftAtEpochMs: epochMillisecondsSchema.nullable(),
    position: z.number().int().min(1).max(100_000).nullable(),
}).superRefine((value, context) => {
    const waitingShape = value.leftAtEpochMs === null && value.position !== null;
    const completedShape = value.leftAtEpochMs !== null && value.position === null;
    if ((value.status === 'waiting' && !waitingShape) || (value.status !== 'waiting' && !completedShape)) {
        context.addIssue({code: 'custom', message: 'queue state fields are incoherent'});
    }
    if (value.leftAtEpochMs !== null && value.leftAtEpochMs < value.joinedAtEpochMs) {
        context.addIssue({code: 'custom', message: 'leftAtEpochMs must not precede joinedAtEpochMs'});
    }
});

export const laundryQueueListSchema = z.strictObject({
    entries: z.array(laundryQueueEntrySchema).max(32),
});

export type AttendancePreferences = z.infer<typeof attendancePreferencesSchema>;
export type MealPreferencesInput = z.infer<typeof mealPreferencesInputSchema>;
export type MealPreferences = z.infer<typeof mealPreferencesSchema>;
export type LaundryApplianceKind = z.infer<typeof laundryApplianceSchema>;
export type LaundryWatchInput = z.infer<typeof laundryWatchInputSchema>;
export type LaundryWatch = z.infer<typeof laundryWatchSchema>;
export type LaundryQueueInput = z.infer<typeof laundryQueueInputSchema>;
export type LaundryQueueEntry = z.infer<typeof laundryQueueEntrySchema>;
