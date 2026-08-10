import { type Hook } from "@hono/zod-validator";
import type { Env as HonoEnvironment } from "hono";
import { z } from "zod";
import { isAllowedBrowserPushEndpoint } from "../renewal/push-sender";

export const rfc3339Schema = z.iso.datetime({ offset: true });
export const timeQuerySchema = z.object({ time: rfc3339Schema });
export const minuteParamSchema = z.object({ minute: z.string().regex(/^\d{8}T\d{4}Z$/) });
export const shaParamSchema = z.object({ sha: z.string().regex(/^[a-f0-9]{64}$/) });
export const eventsQuerySchema = z.object({
  since: rfc3339Schema.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
export const mealHistoryQuerySchema = z.object({
  before: rfc3339Schema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export const assetParamSchema = z.object({ asset: z.string().regex(/^[a-f0-9]{64}\.[a-z0-9]{1,8}$/) });
export const installationIdSchema = z.string().min(8).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]+$/u);
export const mobileInstallationIdSchema = z.string().regex(/^jbmi_[a-f0-9]{32}$/u);
export const pairingIdSchema = z.string().regex(/^jbp_[0-9a-f-]{36}$/u);
export const desktopEnrollmentSchema = z.object({ installationId: installationIdSchema }).strict();
export const emptyObjectSchema = z.object({}).strict();
export const heartbeatSchema = z.object({
  lmsSessionState: z.enum(["connected", "login-required", "unknown"]),
  appVersion: z.string().trim().min(1).max(64).nullable(),
}).strict();
export const pairingParamSchema = z.object({ id: pairingIdSchema }).strict();
export const qrClaimSchema = z.object({
  challenge: z.string().regex(/^jbpc_[a-f0-9]{64}$/u),
  deviceLabel: z.string().trim().min(1).max(80),
  installationId: mobileInstallationIdSchema,
}).strict();
export const manualClaimSchema = z.object({
  manualCode: z.string().trim().min(10).max(32),
  deviceLabel: z.string().trim().min(1).max(80),
  installationId: mobileInstallationIdSchema,
}).strict();
export const attendanceSnapshotSchema = z.object({
  attendanceDate: z.iso.date(),
  cohortId: z.string().trim().min(1).max(128).nullable(),
  cohortStatus: z.enum(["active", "upcoming", "ended", "none", "unknown"]),
  cohortStartDate: z.iso.date().nullable(),
  cohortEndDate: z.iso.date().nullable(),
  morningChecked: z.boolean(),
  eveningChecked: z.boolean(),
  collectedAt: rfc3339Schema,
}).strict().refine((value) => value.cohortStartDate === null || value.cohortEndDate === null || value.cohortStartDate <= value.cohortEndDate, {
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
export const attendancePreferenceSchema = z.object({
  morning: z.boolean(), evening: z.boolean(), skipSunday: z.boolean(),
  skipAttendanceDate: z.iso.date().nullable(),
}).strict();
export const mealPreferenceSchema = z.object({
  enabled: z.boolean(), breakfast: z.boolean(), lunch: z.boolean(), dinner: z.boolean(),
}).strict();
export const laundryWatchSchema = z.object({
  machineId: z.string().trim().min(1).max(128),
  appliance: z.enum(["washer", "dryer"]),
  sessionId: z.string().trim().min(1).max(256).nullable(),
  notifyBeforeMinutes: z.number().int().min(0).max(180),
  notifyWhenAvailable: z.boolean(),
}).strict();
export const laundryQueueSchema = z.object({
  machineId: z.string().trim().min(1).max(128).nullable(),
  appliance: z.enum(["washer", "dryer"]),
}).strict();
export const laundryWatchParamSchema = z.object({ id: z.string().regex(/^jbw_[a-f0-9]{64}$/u) }).strict();
export const laundryQueueParamSchema = z.object({ id: z.string().regex(/^jbq_[a-f0-9]{64}$/u) }).strict();
export const deviceParamSchema = z.object({ id: z.string().regex(/^jbsi_[0-9a-f-]{36}$/u) }).strict();
export const notificationParamSchema = z.object({ id: z.string().uuid() }).strict();
export const notificationInboxSchema = z.object({ limit: z.coerce.number().int().min(1).max(20).default(20) });
export const notificationAckSchema = z.object({
  outcome: z.enum(["displayed", "failed"]), occurredAtEpochMs: z.number().int().nonnegative(),
}).strict();
export const testNotificationSchema = z.object({ desktopDelivered: z.boolean().optional() }).strict();
export const pushSubscriptionSchema = z.object({
  endpoint: z.string().max(2_048).refine(isAllowedBrowserPushEndpoint),
  keys: z.object({
    p256dh: z.string().min(40).max(256).regex(/^[A-Za-z0-9_-]+={0,2}$/u),
    auth: z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+={0,2}$/u),
  }).strict(),
}).strict();
export const pushParamSchema = z.object({ id: z.string().regex(/^jbps_[a-f0-9]{64}$/u) }).strict();

export const validationHook: Hook<unknown, HonoEnvironment, string> = (result, context) => {
  if (result.success) return;
  return context.json({
    error: "INVALID_REQUEST",
    issues: result.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
  }, 400);
};
