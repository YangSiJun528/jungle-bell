import { type Hook } from "@hono/zod-validator";
import type { Env as HonoEnvironment } from "hono";
import { z } from "zod";
import { isAllowedBrowserPushEndpoint } from "../renewal/push-sender";
import {
  decodeMealHistoryCursor,
  MEAL_HISTORY_CURSOR_MAX_LENGTH,
} from "../domain/meal-history";

export const rfc3339Schema = z.iso.datetime({ offset: true });
export const timeQuerySchema = z.object({ time: rfc3339Schema });
export const minuteParamSchema = z.object({ minute: z.string().regex(/^\d{8}T\d{4}Z$/) });
export const shaParamSchema = z.object({ sha: z.string().regex(/^[a-f0-9]{64}$/) });
export const eventsQuerySchema = z.object({
  since: rfc3339Schema.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
export const mealHistoryQuerySchema = z.object({
  before: z.string().max(MEAL_HISTORY_CURSOR_MAX_LENGTH)
    .refine((value) => decodeMealHistoryCursor(value) !== null)
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export const assetParamSchema = z.object({ asset: z.string().regex(/^[a-f0-9]{64}\.[a-z0-9]{1,8}$/) });
export const installationIdSchema = z.string().min(8).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]+$/u);
export const mobileInstallationIdSchema = z.string().regex(/^jbmi_[a-f0-9]{32}$/u);
export const pairingIdSchema = z.string().regex(/^jbp_[0-9a-f-]{36}$/u);
export const desktopEnrollmentSchema = z.strictObject({ installationId: installationIdSchema });
export const emptyObjectSchema = z.strictObject({});
export const heartbeatSchema = z.strictObject({
  lmsSessionState: z.enum(["connected", "login-required", "unknown"]),
  appVersion: z.string().trim().min(1).max(64).nullable(),
});
export const pairingParamSchema = z.strictObject({ id: pairingIdSchema });
export const qrClaimSchema = z.strictObject({
  challenge: z.string().regex(/^jbpc_[a-f0-9]{64}$/u),
  deviceLabel: z.string().trim().min(1).max(80),
  installationId: mobileInstallationIdSchema,
});
export const manualClaimSchema = z.strictObject({
  manualCode: z.string().trim().min(10).max(32),
  deviceLabel: z.string().trim().min(1).max(80),
  installationId: mobileInstallationIdSchema,
});
export const attendanceSnapshotSchema = z.strictObject({
  attendanceDate: z.iso.date(),
  cohortId: z.string().trim().min(1).max(128).nullable(),
  cohortStatus: z.enum(["active", "upcoming", "ended", "none", "unknown"]),
  cohortStartDate: z.iso.date().nullable(),
  cohortEndDate: z.iso.date().nullable(),
  morningChecked: z.boolean(),
  eveningChecked: z.boolean(),
  collectedAt: rfc3339Schema,
}).refine((value) => value.cohortStartDate === null || value.cohortEndDate === null || value.cohortStartDate <= value.cohortEndDate, {
  message: "Invalid cohort date range",
}).refine((value) => {
  if (value.cohortStatus === "active") return value.cohortId !== null;
  if (value.cohortStatus === "upcoming" || value.cohortStatus === "ended") {
    return value.cohortId === null && !value.morningChecked && !value.eveningChecked;
  }
  if (value.cohortStatus === "none") {
    return value.cohortId === null && value.cohortStartDate === null && value.cohortEndDate === null
      && !value.morningChecked && !value.eveningChecked;
  }
  return value.cohortId === null;
}, { message: "Incoherent attendance cohort state" });
export const deviceParamSchema = z.strictObject({ id: z.string().regex(/^jbsi_[0-9a-f-]{36}$/u) });
export const notificationParamSchema = z.strictObject({ id: z.uuid() });
export const notificationInboxSchema = z.object({ limit: z.coerce.number().int().min(1).max(20).default(20) });
export const notificationAckSchema = z.strictObject({
  outcome: z.enum(["displayed", "failed"]), occurredAtEpochMs: z.number().int().nonnegative(),
});
export const testNotificationSchema = z.strictObject({ desktopDelivered: z.boolean().optional() });
export const pushSubscriptionSchema = z.strictObject({
  endpoint: z.string().max(2_048).refine(isAllowedBrowserPushEndpoint),
  keys: z.strictObject({
    p256dh: z.string().min(40).max(256).regex(/^[A-Za-z0-9_-]+={0,2}$/u),
    auth: z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+={0,2}$/u),
  }),
});
export const pushParamSchema = z.strictObject({ id: z.string().regex(/^jbps_[a-f0-9]{64}$/u) });

export const validationHook: Hook<unknown, HonoEnvironment, string> = (result, context) => {
  if (result.success) return;
  return context.json({
    error: "INVALID_REQUEST",
    issues: result.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
  }, 400);
};
