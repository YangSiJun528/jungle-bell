import {z} from 'zod';
import type {
    DashboardLaundryMachine,
    LaundryCapacityEstimate,
    LaundryCapacitySnapshot,
} from '@/domain/laundry/capacity';
import {parseResponse} from './api-response';
import {
    boundedLaundryCountSchema,
    calendarDateSchema,
    finiteNumberSchema,
    isoDateTimeSchema,
    refreshIntervalSecondsSchema,
    textSchema,
} from './dashboard-contract-shared';

const laundryProjectionSchema = z.object({
    status: textSchema(64),
    remainingMinutes: finiteNumberSchema.nullable().optional(),
    estimated: z.boolean().optional(),
});

const laundryStateSchema = z.object({
    code: z.string().optional(),
    labelKo: z.string().optional(),
});

function riskLevel(rate: number): 'safe' | 'slight' | 'caution' {
    if (rate > 40) return 'caution';
    if (rate > 10) return 'slight';
    return 'safe';
}

export const dashboardLaundryApplianceSchema = z.object({
    appliance: z.enum(['washer', 'dryer']),
    operationalStatus: textSchema(64),
    projection: laundryProjectionSchema.nullish().transform((value) => value ?? null),
    state: laundryStateSchema.nullish().transform((value) => value ?? null),
    remainingMinutes: finiteNumberSchema.nullable(),
    totalMinutes: finiteNumberSchema.optional(),
    startedAt: isoDateTimeSchema.nullable(),
    estimatedFinishAt: isoDateTimeSchema.nullable(),
    observedAt: isoDateTimeSchema.optional(),
    sessionId: textSchema(512).nullable(),
    errorCode: textSchema(128).nullable(),
    attempts: z.number().int().min(0).max(100_000).default(0),
    errors: z.number().int().min(0).max(100_000).default(0),
    rate: z.number().finite().min(0).max(100).default(0),
    riskLevel: z.enum(['safe', 'slight', 'caution']).default('safe'),
}).superRefine((value, context) => {
    const expectedRate = value.attempts === 0
        ? 0
        : value.errors * 100 / value.attempts;
    if (value.errors > value.attempts
        || Math.abs(value.rate - expectedRate) > Number.EPSILON * 100
        || value.riskLevel !== riskLevel(value.rate)) {
        context.addIssue({
            code: 'custom',
            message: '최근 7일 세탁 에러 위험 지표가 올바르지 않습니다.',
        });
    }
});

export type DashboardLaundryAppliance = z.infer<typeof dashboardLaundryApplianceSchema>;

function machineZone(id: string): DashboardLaundryMachine['zone'] {
    const number = Number(/(?:워시타워[_\s-]*)?(\d+)$/u.exec(id.trim())?.[1] ?? Number.NaN);
    if (number >= 1 && number <= 5) return 'men';
    if (number >= 6 && number <= 7) return 'common';
    if (number >= 8 && number <= 9) return 'women';
    return 'other';
}

const laundryMachineSchema = z.object({
    id: textSchema(128),
    washer: dashboardLaundryApplianceSchema.nullable(),
    dryer: dashboardLaundryApplianceSchema.nullable(),
}).transform(({id, washer, dryer}): DashboardLaundryMachine => ({
    id,
    zone: machineZone(id),
    washer,
    dryer,
}));

function laundryCapacityEstimateSchema<TAccess extends LaundryCapacityEstimate['access']>(
    access: TAccess,
) {
    return z.strictObject({
        access: z.literal(access),
        washerAvailable: boundedLaundryCountSchema,
        projectedDryerSupply: boundedLaundryCountSchema,
        pendingDryerLoads: boundedLaundryCountSchema,
        dryerHeadroom: boundedLaundryCountSchema,
        startableLoads: boundedLaundryCountSchema.nullable(),
        reliable: z.boolean(),
    }).superRefine((value, context) => {
        const expectedHeadroom = Math.max(0, value.projectedDryerSupply - value.pendingDryerLoads);
        const expectedStartable = Math.min(value.washerAvailable, value.dryerHeadroom);
        if (value.dryerHeadroom !== expectedHeadroom
            || value.reliable !== (value.startableLoads !== null)
            || (value.reliable && value.startableLoads !== expectedStartable)) {
            context.addIssue({
                code: 'custom',
                message: '세탁 가능 횟수 불변식이 올바르지 않습니다.',
            });
        }
    });
}

const laundryCapacitySchema: z.ZodType<LaundryCapacitySnapshot> = z.strictObject({
    basis: z.literal('WASHER_AND_DRYER_HEADROOM_60_MIN'),
    men: laundryCapacityEstimateSchema('men'),
    women: laundryCapacityEstimateSchema('women'),
});

export const dashboardLaundrySnapshotSchema = z.object({
    schemaVersion: z.literal(1),
    asOf: isoDateTimeSchema,
    final: z.boolean(),
    quality: z.object({
        collectorHealthy: z.boolean(),
        collection: z.enum(['SUCCESS', 'STALE']),
        sourceFreshness: z.enum([
            'REFRESH_OBSERVED',
            'WITHIN_REFRESH_WINDOW',
            'REFRESH_OVERDUE',
            'UNVERIFIABLE_STABLE',
            'COLLECTION_GAP',
        ]),
        lastCheckedAt: isoDateTimeSchema.nullable(),
        expectedRefreshIntervalSeconds: refreshIntervalSecondsSchema,
    }),
    machines: z.array(laundryMachineSchema).max(64),
    capacity: laundryCapacitySchema.nullish().transform((value) => value ?? null),
});

export type DashboardLaundrySnapshot = z.infer<typeof dashboardLaundrySnapshotSchema>;

const MEAL_IMAGE_TYPES = {
    avif: 'image/avif',
    gif: 'image/gif',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
} as const;

const mealShaSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const mealImageExtensionSchema = z.string()
    .min(1)
    .max(8)
    .transform((value) => value.toLowerCase())
    .pipe(z.enum(['avif', 'gif', 'jpg', 'jpeg', 'png', 'webp']));

function normalizedMealAssetUrl(
    value: string,
    sha: string,
    extension: string,
    expectedOrigin: string | null,
): string | null {
    try {
        const parsed = new URL(value);
        const localHttp = parsed.protocol === 'http:'
            && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost');
        if ((parsed.protocol !== 'https:' && !localHttp)
            || parsed.username
            || parsed.password
            || (expectedOrigin !== null && parsed.origin !== expectedOrigin)
            || parsed.pathname !== `/api/public/assets/${sha}.${extension}`
            || parsed.search
            || parsed.hash) {
            return null;
        }
        return parsed.toString();
    } catch {
        return null;
    }
}

function mealImageSchema(expectedAssetOrigin: string | null) {
    return z.object({
        sha: mealShaSchema,
        url: z.string().max(2_048),
        contentType: z.enum([
            'image/avif', 'image/gif', 'image/jpeg', 'image/png', 'image/webp',
        ]),
        extension: mealImageExtensionSchema,
        width: z.number().int().min(1).max(20_000).nullable(),
        height: z.number().int().min(1).max(20_000).nullable(),
        byteLength: z.number().int().min(1).max(25_000_000),
    }).superRefine((image, context) => {
        if (image.contentType !== MEAL_IMAGE_TYPES[image.extension]
            || normalizedMealAssetUrl(
                image.url,
                image.sha,
                image.extension,
                expectedAssetOrigin,
            ) === null) {
            context.addIssue({code: 'custom', message: '허용되지 않은 급식 이미지입니다.'});
        }
    }).transform((image) => ({
        ...image,
        url: normalizedMealAssetUrl(
            image.url,
            image.sha,
            image.extension,
            expectedAssetOrigin,
        ) as string,
    }));
}

export type DashboardMealImage = z.output<ReturnType<typeof mealImageSchema>>;

export function safeMealPermalink(value: unknown): string | null {
    if (typeof value !== 'string' || value.length > 2_048) return null;
    try {
        const parsed = new URL(value.replace(/^http:\/\//u, 'https://'));
        const safe = parsed.origin === 'https://pf.kakao.com'
            && !parsed.username
            && !parsed.password
            && /^\/_xhzNjn\/(?:posts|[1-9][0-9]*)$/u.test(parsed.pathname)
            && parsed.search === ''
            && parsed.hash === '';
        return safe ? parsed.toString() : null;
    } catch {
        return null;
    }
}

function mealPostSchema(expectedAssetOrigin: string | null) {
    return z.object({
        id: textSchema(128),
        kind: z.enum(['PINNED_MENU', 'DAILY_MENU', 'OTHER']).optional(),
        contentSha: mealShaSchema.optional(),
        title: textSchema(1_024).nullable(),
        text: z.string().max(100_000),
        pinned: z.boolean().optional(),
        publishedAt: isoDateTimeSchema.nullable(),
        updatedAt: isoDateTimeSchema.nullable().optional(),
        permalink: z.unknown().transform(safeMealPermalink),
        status: textSchema(128).nullable().optional(),
        images: z.array(mealImageSchema(expectedAssetOrigin)).max(12).optional(),
        firstSeenAt: isoDateTimeSchema.optional(),
        lastSeenAt: isoDateTimeSchema.optional(),
    });
}

export type DashboardMealPost = z.output<ReturnType<typeof mealPostSchema>>;

const mealWeekKeySchema = calendarDateSchema.refine(
    (value) => new Date(`${value}T00:00:00.000Z`).getUTCDay() === 1,
    '주간 식단 키는 월요일이어야 합니다.',
);

function currentWeeklyMealMenuSchema(expectedAssetOrigin: string | null) {
    return z.strictObject({
        targetWeekKey: mealWeekKeySchema,
        status: z.enum(['AVAILABLE', 'AWAITING_UPDATE']),
        contentSha: mealShaSchema.nullable(),
        post: mealPostSchema(expectedAssetOrigin).nullable(),
    }).superRefine((value, context) => {
        const available = value.contentSha !== null && value.post !== null;
        if ((value.status === 'AVAILABLE') !== available
            || (value.post?.contentSha !== undefined && value.post.contentSha !== value.contentSha)) {
            context.addIssue({code: 'custom', message: '현재 주간 식단 계약이 올바르지 않습니다.'});
        }
    });
}

export type DashboardCurrentWeeklyMealMenu = z.output<
    ReturnType<typeof currentWeeklyMealMenuSchema>
>;

function weeklyMealMenuSchema(expectedAssetOrigin: string | null) {
    return z.strictObject({
        weekKey: mealWeekKeySchema,
        contentSha: mealShaSchema,
        post: mealPostSchema(expectedAssetOrigin),
    }).superRefine((value, context) => {
        if (value.post.contentSha !== undefined && value.post.contentSha !== value.contentSha) {
            context.addIssue({code: 'custom', message: '주간 식단 SHA가 일치하지 않습니다.'});
        }
    });
}

export type DashboardWeeklyMealMenu = z.output<ReturnType<typeof weeklyMealMenuSchema>>;

function dashboardMealsSnapshotSchema(expectedAssetOrigin: string | null) {
    return z.object({
        asOf: isoDateTimeSchema,
        lastCheckedAt: isoDateTimeSchema.nullable(),
        data: z.object({
            schemaVersion: z.literal(2),
            dailyMenus: z.array(mealPostSchema(expectedAssetOrigin)).max(128),
            pinnedMenus: z.array(mealPostSchema(expectedAssetOrigin)).max(128),
            recentMenus: z.array(mealPostSchema(expectedAssetOrigin)).max(128),
            currentWeeklyMenu: currentWeeklyMealMenuSchema(expectedAssetOrigin).nullable(),
            weeklyMenus: z.array(weeklyMealMenuSchema(expectedAssetOrigin)).max(100),
        }),
    });
}

export type DashboardMealsSnapshot = z.output<ReturnType<typeof dashboardMealsSnapshotSchema>>;

export interface DashboardMealHistoryMonth {
    posts: DashboardMealPost[];
}

export function parseDashboardLaundrySnapshot(value: unknown): DashboardLaundrySnapshot {
    return parseResponse(dashboardLaundrySnapshotSchema, value);
}

export function parseDashboardMealsSnapshot(
    value: unknown,
    expectedAssetOrigin: string | null = null,
): DashboardMealsSnapshot {
    return parseResponse(dashboardMealsSnapshotSchema(expectedAssetOrigin), value);
}

export function parseDashboardMealHistoryMonth(
    value: unknown,
    expectedAssetOrigin: string | null = null,
): DashboardMealHistoryMonth {
    const schema = z.strictObject({
        posts: z.array(mealPostSchema(expectedAssetOrigin)).max(100),
    });
    return parseResponse(schema, value);
}
