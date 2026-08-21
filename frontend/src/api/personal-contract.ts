import {z} from 'zod';

const canonicalString = (maximum: number) =>
    z
        .string()
        .min(1)
        .max(maximum)
        .refine((value) => value.trim() === value, '앞뒤 공백은 허용되지 않습니다.');

const epochMillisecondsSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const attendancePreferencesSchema = z.strictObject({
    enabled: z.boolean(),
    morning: z.boolean(),
    evening: z.boolean(),
    morningStartHour: z.number().int().min(4).max(9),
    eveningEndHour: z.number().int().min(0).max(4),
    morningIntervalMinutes: z.union([
        z.literal(1),
        z.literal(3),
        z.literal(5),
        z.literal(10),
        z.literal(15),
        z.literal(30),
    ]),
    eveningIntervalMinutes: z.union([
        z.literal(1),
        z.literal(3),
        z.literal(5),
        z.literal(10),
        z.literal(15),
        z.literal(30),
    ]),
    skipSunday: z.boolean(),
    skipAttendanceDate: z.iso.date().nullable(),
});

export const mealPreferencesInputSchema = z.strictObject({
    enabled: z.boolean(),
    lunch: z.boolean(),
    dinner: z.boolean(),
});

export const mealPreferencesSchema = mealPreferencesInputSchema.extend({
    updatedAtEpochMs: epochMillisecondsSchema,
});

export const laundryApplianceSchema = z.enum(['washer', 'dryer']);
export const laundryNotificationModeSchema = z.enum([
    'before-completion',
    'estimated-completion',
    'confirmed-completion',
]);

const validLaundryNotificationMinutes = (value: {
    notificationMode: z.infer<typeof laundryNotificationModeSchema>;
    notifyBeforeMinutes: number;
}) =>
    value.notificationMode === 'before-completion'
        ? value.notifyBeforeMinutes > 0
        : value.notifyBeforeMinutes === 0;

export const laundryWatchInputSchema = z
    .strictObject({
        machineId: canonicalString(128),
        appliance: laundryApplianceSchema,
        sessionId: canonicalString(256),
        notificationMode: laundryNotificationModeSchema,
        notifyBeforeMinutes: z.number().int().min(0).max(180),
    })
    .refine(validLaundryNotificationMinutes, {
        message: '선택한 알림 시점과 남은 시간 값이 일치하지 않습니다.',
    });

export const laundryWatchIdSchema = z.string().regex(/^jbw_[a-f0-9]{64}$/u);

export const laundryWatchSchema = z
    .strictObject({
        id: laundryWatchIdSchema,
        machineId: canonicalString(128),
        appliance: laundryApplianceSchema,
        sessionId: canonicalString(256).nullable(),
        notificationMode: laundryNotificationModeSchema,
        notifyBeforeMinutes: z.number().int().min(0).max(180),
        status: z.enum(['active', 'completed', 'cancelled']),
        createdAtEpochMs: epochMillisecondsSchema,
        updatedAtEpochMs: epochMillisecondsSchema,
    })
    .refine(validLaundryNotificationMinutes, {
        message: '선택한 알림 시점과 남은 시간 값이 일치하지 않습니다.',
    })
    .refine((value) => value.updatedAtEpochMs >= value.createdAtEpochMs, {
        message: 'updatedAtEpochMs must not precede createdAtEpochMs',
    });

export const laundryWatchListSchema = z.strictObject({
    watches: z.array(laundryWatchSchema).max(128),
});

export type AttendancePreferences = z.infer<typeof attendancePreferencesSchema>;
export type MealPreferencesInput = z.infer<typeof mealPreferencesInputSchema>;
export type MealPreferences = z.infer<typeof mealPreferencesSchema>;
export type LaundryApplianceKind = z.infer<typeof laundryApplianceSchema>;
export type LaundryNotificationMode = z.infer<typeof laundryNotificationModeSchema>;
export type LaundryWatchInput = z.infer<typeof laundryWatchInputSchema>;
export type LaundryWatch = z.infer<typeof laundryWatchSchema>;
