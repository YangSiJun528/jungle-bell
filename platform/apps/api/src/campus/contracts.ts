import { z } from "zod";

export const campusKindSchema = z.enum(["laundry", "meals"]);
export type CampusKind = z.infer<typeof campusKindSchema>;

export const applianceKindSchema = z.enum(["washer", "dryer"]);
export type ApplianceKind = z.infer<typeof applianceKindSchema>;

const normalizedStateSchema = z
  .object({
    code: z.string().min(1).max(128),
    raw: z.string().max(256).nullable(),
    known: z.boolean(),
  })
  .loose();

const laundryProjectionSchema = z
  .object({
    asOf: z.iso.datetime({ offset: true }),
    remainingMinutes: z.number().int().nonnegative().nullable(),
    status: z.enum([
      "OBSERVED",
      "ESTIMATED_RUNNING",
      "AWAITING_COMPLETION_CONFIRMATION",
      "CONFIRMED_COMPLETED",
      "PAUSED",
      "ERROR",
      "IDLE",
      "UNKNOWN",
    ]),
    estimated: z.boolean(),
  })
  .loose();

export const laundryApplianceSchema = z
  .object({
    machineId: z.string().trim().min(1).max(128),
    appliance: applianceKindSchema,
    observedAt: z.iso.datetime({ offset: true }),
    state: normalizedStateSchema,
    operationalStatus: z.enum([
      "IDLE",
      "SCHEDULED",
      "RUNNING",
      "PAUSED",
      "ERROR",
      "COMPLETED",
      "UNKNOWN",
    ]),
    remainingMinutes: z.number().int().nonnegative(),
    totalMinutes: z.number().int().nonnegative(),
    startedAt: z.iso.datetime({ offset: true }),
    estimatedFinishAt: z.iso.datetime({ offset: true }).nullable(),
    remoteControlEnabled: z.boolean().nullable(),
    cycleCount: z.number().int().nonnegative().nullable(),
    sessionId: z.string().max(256).nullable(),
    errorCode: z.string().max(256).nullable(),
    projection: laundryProjectionSchema,
  })
  .loose();

export const laundryEventSchema = z
  .object({
    id: z.string().min(1).max(512),
    machineId: z.string().min(1).max(128),
    appliance: applianceKindSchema,
    sessionId: z.string().max(256).nullable(),
    type: z.enum([
      "STARTED",
      "STATE_CHANGED",
      "COUNTDOWN_NORMAL",
      "ETA_EXTENDED",
      "ETA_REDUCED",
      "TOTAL_TIME_ADJUSTED",
      "PAUSED",
      "ERROR_ENTERED",
      "ERROR_CLEARED",
      "COMPLETED",
      "STOPPED_UNEXPECTEDLY",
      "UNKNOWN_STATE",
    ]),
    previousObservedAt: z.iso.datetime({ offset: true }).nullable(),
    observedAt: z.iso.datetime({ offset: true }),
    etaDeltaMinutes: z
      .number()
      .finite()
      .min(Number.MIN_SAFE_INTEGER)
      .max(Number.MAX_SAFE_INTEGER)
      .nullable(),
    previousState: z.string().max(256).nullable(),
    currentState: z.string().max(256),
    detail: z.record(z.string(), z.unknown()),
  })
  .loose();

export const laundryResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    sourceVersionSha: z.string().min(1).max(256),
    asOf: z.iso.datetime({ offset: true }),
    final: z.boolean(),
    quality: z
      .object({
        collection: z.enum(["SUCCESS", "STALE"]),
        sourceFreshness: z.enum([
          "REFRESH_OBSERVED",
          "WITHIN_REFRESH_WINDOW",
          "REFRESH_OVERDUE",
          "UNVERIFIABLE_STABLE",
          "COLLECTION_GAP",
        ]),
        certainty: z.enum([
          "OBSERVED_API_VALUE",
          "PROVISIONAL_DEVICE_STATE",
          "UNAVAILABLE",
        ]),
        basis: z.enum(["SOURCE_TIMESTAMP", "HASH_CADENCE"]),
        lastCheckedAt: z.iso.datetime({ offset: true }).nullable(),
        expectedRefreshIntervalSeconds: z.number().int().positive(),
      })
      .loose(),
    machines: z.array(
      z
        .object({
          id: z.string().trim().min(1).max(128),
          washer: laundryApplianceSchema.nullable(),
          dryer: laundryApplianceSchema.nullable(),
        })
        .loose(),
    ),
    events: z.array(laundryEventSchema),
    unknownEnums: z.array(z.unknown()),
  })
  .loose();

const mealImageSchema = z
  .object({
    sourceUrl: z.url().optional(),
    url: z.url().optional(),
    contentType: z.string().max(256).optional(),
    width: z.number().int().nonnegative().nullable().optional(),
    height: z.number().int().nonnegative().nullable().optional(),
  })
  .loose();

export const mealPostSchema = z
  .object({
    id: z.string().min(1).max(256),
    kind: z.enum(["PINNED_MENU", "DAILY_MENU", "OTHER"]),
    contentSha: z.string().min(1).max(256),
    title: z.string().max(1_024).nullable(),
    text: z.string().max(100_000),
    pinned: z.boolean(),
    publishedAt: z.iso.datetime({ offset: true }).nullable(),
    updatedAt: z.iso.datetime({ offset: true }).nullable(),
    permalink: z.url().nullable(),
    status: z.string().max(256).nullable(),
    images: z.array(mealImageSchema),
  })
  .loose();

const currentWeeklyMenuSchema = z
  .object({
    targetWeekKey: z.iso.date(),
    status: z.enum(["AVAILABLE", "AWAITING_UPDATE"]),
    contentSha: z.string().min(1).max(256).nullable(),
    post: mealPostSchema.nullable(),
  })
  .loose();

export const mealsResponseSchema = z
  .object({
    asOf: z.iso.datetime({ offset: true }),
    lastCheckedAt: z.iso.datetime({ offset: true }).nullable(),
    data: z
      .object({
        schemaVersion: z.literal(2),
        sourceVersionSha: z.string().min(1).max(256),
        observedAt: z.iso.datetime({ offset: true }),
        hasNext: z.boolean(),
        pinnedMenus: z.array(mealPostSchema),
        dailyMenus: z.array(mealPostSchema),
        otherPosts: z.array(mealPostSchema),
        currentWeeklyMenu: currentWeeklyMenuSchema,
        recentMenus: z.array(mealPostSchema),
        weeklyMenus: z.array(
          z
            .object({
              weekKey: z.iso.date(),
              contentSha: z.string().min(1).max(256),
              post: mealPostSchema,
            })
            .loose(),
        ),
        historyNextBefore: z.string().nullable(),
      })
      .loose(),
  })
  .loose();

export const mealHistoryPageSchema = z
  .object({
    posts: z.array(mealPostSchema),
    nextBefore: z.string().nullable(),
  })
  .loose();

export type LaundryResponse = z.infer<typeof laundryResponseSchema>;
export type LaundryAppliance = z.infer<typeof laundryApplianceSchema>;
export type LaundryEvent = z.infer<typeof laundryEventSchema>;
export type MealsResponse = z.infer<typeof mealsResponseSchema>;
export type MealPost = z.infer<typeof mealPostSchema>;
export type MealHistoryPage = z.infer<typeof mealHistoryPageSchema>;

export interface CampusDataByKind {
  readonly laundry: LaundryResponse;
  readonly meals: MealsResponse;
}

export type CampusSnapshotData<K extends CampusKind = CampusKind> =
  CampusDataByKind[K];

export interface PublicCampusSnapshot<K extends CampusKind = CampusKind> {
  readonly kind: K;
  readonly data: CampusSnapshotData<K> | null;
  readonly etag: string | null;
  readonly savedAtEpochMs: number | null;
  readonly lastCheckedAtEpochMs: number | null;
  readonly stale: boolean;
  readonly lastError: string | null;
}

export const mealRuleSchema = z
  .object({
    enabled: z.boolean(),
    breakfast: z.boolean(),
    lunch: z.boolean(),
    dinner: z.boolean(),
  })
  .strict();

export interface UserMealRule extends z.infer<typeof mealRuleSchema> {
  readonly userId: string;
  readonly updatedAtEpochMs: number;
}

export const attendanceRuleSchema = z
  .object({
    enabled: z.boolean(),
    morning: z.boolean(),
    evening: z.boolean(),
  })
  .strict();

export interface UserAttendanceRule
  extends z.infer<typeof attendanceRuleSchema> {
  readonly userId: string;
  readonly updatedAtEpochMs: number;
}

export const laundryWatchInputSchema = z
  .object({
    machineId: z.string().trim().min(1).max(128),
    appliance: applianceKindSchema,
    sessionId: z.string().trim().min(1).max(256).nullable(),
    notifyBeforeMinutes: z.number().int().min(0).max(180),
    notifyWhenAvailable: z.boolean(),
  })
  .strict();

export type LaundryWatchStatus = "active" | "completed" | "cancelled";

export interface LaundryWatch
  extends z.infer<typeof laundryWatchInputSchema> {
  readonly id: string;
  readonly userId: string;
  readonly status: LaundryWatchStatus;
  readonly createdAtEpochMs: number;
  readonly updatedAtEpochMs: number;
}

export const laundryQueueInputSchema = z
  .object({
    machineId: z.string().trim().min(1).max(128).nullable(),
    appliance: applianceKindSchema,
  })
  .strict();

export type LaundryQueueStatus =
  | "waiting"
  | "claimed"
  | "cancelled"
  | "expired";

export interface LaundryQueueEntry
  extends z.infer<typeof laundryQueueInputSchema> {
  readonly id: string;
  readonly userId: string;
  readonly status: LaundryQueueStatus;
  readonly joinedAtEpochMs: number;
  readonly leftAtEpochMs: number | null;
  readonly position: number;
}
