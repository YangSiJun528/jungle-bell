import { zValidator, type Hook } from "@hono/zod-validator";
import { getLogger } from "@logtape/logtape";
import { Hono, type Context, type Env as HonoEnvironment } from "hono";
import { cache } from "hono/cache";
import { cors } from "hono/cors";
import { setCookie } from "hono/cookie";
import { etag } from "hono/etag";
import { z } from "zod";
import { toPublicLaundryVersion, type LaundryVersion } from "../collector/laundry";
import { withLaundryCapacity } from "../collector/laundry-capacity";
import {
  currentWeeklyMealMenu,
  weeklyMealMenu,
  withMealPostContentSha,
  type MealsVersion,
  type WeeklyMealMenu,
} from "../collector/meals";
import { projectLaundry } from "../collector/projection";
import {
  compactUtcMinute,
  floorToMinute,
  minuteEpoch,
  parseCompactUtcMinute,
} from "../collector/time";
import {
  SOURCE_NAMES,
  type SourceName,
  type SourceState,
} from "../collector/types";
import { CloudflareApiStorage } from "./cloudflare-storage";
import {
  D1RenewalStore,
  type AppSessionRecord,
  type AttendanceSnapshotRecord,
  type RenewalStore,
} from "./account-storage";
import { configureWorkerLogging } from "./logging";
import {
  ATTENDANCE_CLIENT_CLOCK_SKEW_MS,
  ATTENDANCE_SNAPSHOT_FRESH_MS,
} from "../renewal/attendance-policy";
import { sha256Hex } from "../renewal/crypto";
import {
  HttpLmsIdentityGateway,
  LmsGatewayError,
  lmsCookieSchema,
  type LmsIdentityGateway,
} from "../renewal/lms-gateway";
import { planAttendanceNotifications } from "../renewal/notification-planner";
import {
  BindingPushRelaySender,
  HttpPushRelaySender,
  deliverDuePushes,
  isAllowedBrowserPushEndpoint,
  type PushRelayBinding,
  type PushSender,
} from "../renewal/push-sender";
import {
  RenewalError,
  approvePairing,
  authenticateSession,
  claimPairing,
  completePairing,
  createPairing,
  pairingStatusAt,
  verifyLmsAndIssueDesktopSession,
  type Principal,
} from "../renewal/service";

interface Env {
  DB: D1Database;
  DATA_BUCKET: R2Bucket;
  PAIRING_SECRET?: string;
  VAPID_PUBLIC_KEY?: string;
  WEB_PUSH_RELAY?: PushRelayBinding;
  WEB_PUSH_RELAY_URL?: string;
  WEB_PUSH_RELAY_TOKEN?: string;
  /** Test/service-binding injection points. */
  LMS_GATEWAY?: LmsIdentityGateway;
  RENEWAL_STORE?: RenewalStore;
  PUSH_SENDER?: PushSender;
}

type Variables = {
  storage: CloudflareApiStorage;
  renewalStore: RenewalStore;
  lmsGateway: LmsIdentityGateway;
};
type AppEnvironment = { Bindings: Env; Variables: Variables };

export const app = new Hono<AppEnvironment>();
const LATEST_CACHE = "public, max-age=15, s-maxage=30, stale-while-revalidate=120";
const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
const MEAL_HISTORY_PAGE_SIZE = 30;
const TEST_NOTIFICATION_RATE_WINDOW_MS = 30_000;
const TEST_NOTIFICATION_TTL_MS = 10 * 60_000;
const MAX_SOURCE_AGE_MS: Record<SourceName, number> = {
  laundry: 3 * 60_000,
  "meals-include-pinned": 12 * 60_000,
  "meals-default": 12 * 60_000,
};
const rfc3339Schema = z.iso.datetime({ offset: true });
const timeQuerySchema = z.object({ time: rfc3339Schema });
const minuteParamSchema = z.object({ minute: z.string().regex(/^\d{8}T\d{4}Z$/) });
const shaParamSchema = z.object({ sha: z.string().regex(/^[a-f0-9]{64}$/) });
const eventsQuerySchema = z.object({
  since: rfc3339Schema.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
const mealHistoryQuerySchema = z.object({
  before: rfc3339Schema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(MEAL_HISTORY_PAGE_SIZE),
});
const assetParamSchema = z.object({ asset: z.string().regex(/^[a-f0-9]{64}\.[a-z0-9]{1,8}$/) });
const installationIdSchema = z.string().min(8).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]+$/u);
const mobileInstallationIdSchema = z.string().regex(/^jbmi_[a-f0-9]{32}$/u);
const pairingIdSchema = z.string().regex(/^jbp_[0-9a-f-]{36}$/u);
const verifyLmsSchema = z.object({
  installationId: installationIdSchema,
  cookies: z.array(lmsCookieSchema).length(1),
}).strict();
const heartbeatSchema = z.object({
  lmsSessionState: z.enum(["connected", "login-required", "unknown"]),
  appVersion: z.string().trim().min(1).max(64).nullable(),
  attendanceNotifications: z.object({
    morning: z.boolean(),
    evening: z.boolean(),
    skipSunday: z.boolean().default(false),
    skipAttendanceDate: z.iso.date().nullable().default(null),
  }).strict().optional(),
}).strict();
const pairingParamSchema = z.object({ id: pairingIdSchema }).strict();
const qrClaimSchema = z.object({
  challenge: z.string().regex(/^jbpc_[a-f0-9]{64}$/u),
  deviceLabel: z.string().trim().min(1).max(80),
  installationId: mobileInstallationIdSchema,
}).strict();
const manualClaimSchema = z.object({
  manualCode: z.string().trim().min(10).max(32),
  deviceLabel: z.string().trim().min(1).max(80),
  installationId: mobileInstallationIdSchema,
}).strict();
const completePairingSchema = z.object({
  claimId: pairingIdSchema.optional(),
  claimReceipt: z.string().regex(/^jbcr_[a-f0-9]{64}$/u),
}).strict();
const isoDateSchema = z.iso.date();
const attendanceSnapshotSchema = z.object({
  attendanceDate: isoDateSchema,
  cohortId: z.string().trim().min(1).max(128).nullable(),
  cohortStatus: z.enum(["active", "upcoming", "ended", "none", "unknown"]),
  cohortStartDate: isoDateSchema.nullable(),
  cohortEndDate: isoDateSchema.nullable(),
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
}, {
  message: "Incoherent attendance cohort state",
});
const attendancePreferenceSchema = z.object({
  morning: z.boolean(),
  evening: z.boolean(),
  skipSunday: z.boolean().optional(),
  skipAttendanceDate: isoDateSchema.nullable().optional(),
}).strict();
const deviceParamSchema = z.object({ id: z.string().regex(/^jbsi_[0-9a-f-]{36}$/u) }).strict();
const notificationParamSchema = z.object({ id: z.string().uuid() }).strict();
const notificationInboxSchema = z.object({ limit: z.coerce.number().int().min(1).max(20).default(20) });
const notificationAckSchema = z.object({
  outcome: z.enum(["displayed", "failed"]),
  occurredAtEpochMs: z.number().int().nonnegative(),
}).strict();
const testNotificationSchema = z.object({
  desktopDelivered: z.boolean().optional(),
}).strict();
const pushSubscriptionSchema = z.object({
  endpoint: z.string().max(2_048).refine(isAllowedBrowserPushEndpoint),
  keys: z.object({
    p256dh: z.string().min(40).max(256).regex(/^[A-Za-z0-9_-]+={0,2}$/u),
    auth: z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+={0,2}$/u),
  }).strict(),
}).strict();
const pushParamSchema = z.object({ id: z.string().regex(/^jbps_[a-f0-9]{64}$/u) }).strict();
const apiLogger = getLogger(["jungle-bell", "api-worker"]);

function currentCacheSlice(): Date {
  return new Date(Math.floor(Date.now() / 30_000) * 30_000);
}

function isPublicApiPath(path: string): boolean {
  return path === "/v1/status"
    || path === "/v1/laundry/head"
    || path === "/v1/laundry/latest"
    || path.startsWith("/v1/laundry/at")
    || path.startsWith("/v1/laundry/minutes/")
    || path.startsWith("/v1/laundry/versions/")
    || path.startsWith("/v1/laundry/events")
    || path === "/v1/meals"
    || path.startsWith("/v1/meals/history")
    || path.startsWith("/v1/assets/");
}

function publicOrigin(requestUrl: string): string {
  return new URL(requestUrl).origin;
}

function bearerToken(context: { req: { header(name: string): string | undefined } }): string {
  const authorization = context.req.header("Authorization");
  const match = /^Bearer (\S+)$/u.exec(authorization ?? "");
  if (!match?.[1]) throw new RenewalError("AUTHENTICATION_REQUIRED", 401);
  return match[1];
}

async function desktopPrincipal(context: {
  req: { header(name: string): string | undefined };
  var: { renewalStore: RenewalStore };
}): Promise<Principal> {
  return authenticateSession(context.var.renewalStore, bearerToken(context), Date.now(), "desktop");
}

async function privatePrincipal(context: {
  req: { header(name: string): string | undefined; raw: Request };
  var: { renewalStore: RenewalStore };
}): Promise<Principal> {
  const authorization = context.req.header("Authorization");
  if (authorization) return authenticateSession(context.var.renewalStore, bearerToken(context), Date.now());
  const token = readCookie(context.req.header("Cookie"), "__Host-jb_device")
    ?? readCookie(context.req.header("Cookie"), "jb_device")
    ?? "";
  return authenticateSession(context.var.renewalStore, token, Date.now(), "mobile");
}

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0 || part.slice(0, index).trim() !== name) continue;
    return part.slice(index + 1).trim();
  }
  return null;
}

function publicAttendance(snapshot: AttendanceSnapshotRecord | null): Record<string, unknown> | null {
  if (!snapshot) return null;
  return {
    attendanceDate: snapshot.attendanceDate,
    cohortId: snapshot.cohortId,
    cohortStatus: snapshot.cohortStatus,
    cohortStartDate: snapshot.cohortStartDate,
    cohortEndDate: snapshot.cohortEndDate,
    morningChecked: snapshot.morningChecked,
    eveningChecked: snapshot.eveningChecked,
    collectedAt: new Date(snapshot.collectedAtEpochMs).toISOString(),
  };
}

function publicAttendanceEnvelope(snapshot: AttendanceSnapshotRecord | null, nowEpochMs: number): {
  attendance: Record<string, unknown> | null;
  freshness: "fresh" | "stale" | "missing";
} {
  if (!snapshot) return { attendance: null, freshness: "missing" };
  const ageEpochMs = nowEpochMs - snapshot.collectedAtEpochMs;
  const freshness = snapshot.collectedAtEpochMs <= nowEpochMs + ATTENDANCE_CLIENT_CLOCK_SKEW_MS
    && ageEpochMs <= ATTENDANCE_SNAPSHOT_FRESH_MS
    ? "fresh"
    : "stale";
  return { attendance: publicAttendance(snapshot), freshness };
}

function requirePairingSecret(env: Env): string {
  if (!env.PAIRING_SECRET || new TextEncoder().encode(env.PAIRING_SECRET).byteLength < 32) {
    throw new RenewalError("PAIRING_SERVICE_UNAVAILABLE", 503);
  }
  return env.PAIRING_SECRET;
}

function configuredPushSender(env: Env): PushSender | null {
  if (env.PUSH_SENDER) return env.PUSH_SENDER;
  if (env.WEB_PUSH_RELAY) return new BindingPushRelaySender(env.WEB_PUSH_RELAY);
  if (!env.WEB_PUSH_RELAY_URL || !env.WEB_PUSH_RELAY_TOKEN) return null;
  try {
    return new HttpPushRelaySender(env.WEB_PUSH_RELAY_URL, env.WEB_PUSH_RELAY_TOKEN);
  } catch {
    return null;
  }
}

function webPushIsConfigured(env: Env): boolean {
  return Boolean(env.VAPID_PUBLIC_KEY && configuredPushSender(env));
}

function setMobileSessionCookie(context: Parameters<typeof setCookie>[0], token: string, expiresAtEpochMs: number): void {
  const secure = new URL(context.req.url).protocol === "https:";
  setCookie(context, secure ? "__Host-jb_device" : "jb_device", token, {
    httpOnly: true,
    secure,
    sameSite: "Strict",
    path: "/",
    expires: new Date(expiresAtEpochMs),
    maxAge: Math.max(0, Math.floor((expiresAtEpochMs - Date.now()) / 1_000)),
  });
}

function clearMobileSessionCookie(context: Parameters<typeof setCookie>[0]): void {
  const secure = new URL(context.req.url).protocol === "https:";
  setCookie(context, secure ? "__Host-jb_device" : "jb_device", "", {
    httpOnly: true,
    secure,
    sameSite: "Strict",
    path: "/",
    maxAge: 0,
  });
}

async function getAttendanceSnapshotRoute(context: Context<AppEnvironment>): Promise<Response> {
  const principal = await privatePrincipal(context);
  const nowEpochMs = Date.now();
  const snapshot = await context.var.renewalStore.getLatestAttendanceSnapshot(principal.userId);
  return context.json(publicAttendanceEnvelope(snapshot, nowEpochMs));
}

async function putAttendanceSnapshotRoute(context: Context<AppEnvironment>): Promise<Response> {
  const parsed = attendanceSnapshotSchema.safeParse(await context.req.json().catch(() => null));
  if (!parsed.success) return context.json({ error: "INVALID_REQUEST" }, 400);
  const principal = await desktopPrincipal(context);
  const body = parsed.data;
  const receivedAtEpochMs = Date.now();
  const collectedAtEpochMs = Date.parse(body.collectedAt);
  if (!Number.isSafeInteger(collectedAtEpochMs) || collectedAtEpochMs > receivedAtEpochMs + ATTENDANCE_CLIENT_CLOCK_SKEW_MS) {
    return context.json({ error: "ATTENDANCE_COLLECTION_TIME_INVALID" }, 400);
  }
  if (!(await context.var.renewalStore.recordDesktopHeartbeat({
    userId: principal.userId,
    installationId: principal.installationId,
    lmsSessionState: "connected",
    appVersion: null,
    nowEpochMs: receivedAtEpochMs,
  }))) return context.json({ error: "DESKTOP_NOT_REGISTERED" }, 409);
  const result = await context.var.renewalStore.putNewestAttendanceSnapshot({
    userId: principal.userId,
    sourceInstallationId: principal.installationId,
    attendanceDate: body.attendanceDate,
    cohortId: body.cohortId,
    cohortStatus: body.cohortStatus,
    cohortStartDate: body.cohortStartDate,
    cohortEndDate: body.cohortEndDate,
    morningChecked: body.morningChecked,
    eveningChecked: body.eveningChecked,
    collectedAtEpochMs,
    receivedAtEpochMs,
  });
  return context.json(publicAttendanceEnvelope(result.snapshot, receivedAtEpochMs));
}

const validationHook: Hook<unknown, HonoEnvironment, string> = (result, context) => {
  if (result.success) return;
  return context.json({
    error: "INVALID_REQUEST",
    issues: result.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    })),
  }, 400);
};

function historicalState(observation: Awaited<ReturnType<CloudflareApiStorage["readObservation"]>>): SourceState | null {
  if (!observation) return null;
  return {
    source: "laundry",
    lastAttemptAt: observation.collectedAt,
    lastSuccessAt: observation.status === "SUCCESS" ? observation.collectedAt : null,
    lastResponseSha: observation.versionSha,
    lastRawKey: observation.rawKey,
    lastNormalizedKey: observation.normalizedKey,
    versionFirstSeenAt: observation.versionFirstSeenAt,
    consecutiveFailures: observation.status === "SUCCESS" ? 0 : 1,
    lastError: observation.error,
  };
}

function withPostAssetUrls<T extends MealsVersion["dailyMenus"][number]>(post: T, requestUrl: string): T {
  const origin = new URL(requestUrl).origin;
  return {
    ...post,
    images: post.images.map((image) => ({
      ...image,
      url: `${origin}/v1/assets/${image.sha}.${image.extension}`,
    })),
  };
}

function withAssetUrls(meals: MealsVersion, requestUrl: string): MealsVersion {
  const mapPost = (post: MealsVersion["pinnedMenus"][number]) => withPostAssetUrls(post, requestUrl);
  return {
    ...meals,
    pinnedMenus: meals.pinnedMenus.map(mapPost),
    dailyMenus: meals.dailyMenus.map(mapPost),
    otherPosts: meals.otherPosts.map(mapPost),
  };
}

async function withContentShas(meals: MealsVersion): Promise<MealsVersion> {
  return {
    ...meals,
    schemaVersion: 2,
    pinnedMenus: await Promise.all(meals.pinnedMenus.map(withMealPostContentSha)),
    dailyMenus: await Promise.all(meals.dailyMenus.map(withMealPostContentSha)),
    otherPosts: await Promise.all(meals.otherPosts.map(withMealPostContentSha)),
  };
}

app.use("*", async (_context, next) => {
  await configureWorkerLogging();
  await next();
});

const publicCors = cors({
  origin: "*",
  allowMethods: ["GET", "HEAD", "OPTIONS"],
  maxAge: 86_400,
});
const privateCors = cors({
  origin: (_origin, context) => publicOrigin(context.req.url),
  allowMethods: ["DELETE", "GET", "HEAD", "OPTIONS", "POST", "PUT"],
  allowHeaders: ["Authorization", "Content-Type"],
  credentials: true,
  maxAge: 86_400,
});
app.use("/v1/*", (context, next) => isPublicApiPath(context.req.path)
  ? publicCors(context, next)
  : privateCors(context, next));

app.use("/v1/*", etag());
const publicApiCache = cache({
  cacheName: "jungle-bell-api-v1",
  onCacheNotAvailable: false,
});
app.use("/v1/*", async (context, next) => {
  if ((context.req.method === "GET" || context.req.method === "HEAD") && isPublicApiPath(context.req.path)) {
    return publicApiCache(context, next);
  }
  await next();
});

app.use("*", async (context, next) => {
  await next();
  if (!context.res.headers.has("Cache-Control")) context.res.headers.set("Cache-Control", "no-store");
});

app.use("*", async (context, next) => {
  context.set("storage", new CloudflareApiStorage(context.env.DB, context.env.DATA_BUCKET));
  context.set("renewalStore", context.env.RENEWAL_STORE ?? new D1RenewalStore(context.env.DB));
  context.set("lmsGateway", context.env.LMS_GATEWAY ?? new HttpLmsIdentityGateway());
  await next();
});

app.use("/v1/*", async (context, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(context.req.method)) return next();
  const origin = context.req.header("Origin");
  if (origin === undefined || origin === publicOrigin(context.req.url)) return next();
  return context.json({ error: "ORIGIN_NOT_ALLOWED" }, 403);
});

app.get("/", (context) => context.redirect("/dashboard.html", 308));

app.get("/healthz", async (context) => {
  const states = await context.var.storage.readAllStates();
  const now = Date.now();
  const degraded = states.length !== SOURCE_NAMES.length || states.some((state) =>
    !state.lastSuccessAt
    || now - Date.parse(state.lastSuccessAt) > MAX_SOURCE_AGE_MS[state.source]
    || state.consecutiveFailures >= 3
  );
  return context.json({
    status: degraded ? "DEGRADED" : "OK",
    checkedAt: new Date(now).toISOString(),
    sources: states,
  }, degraded ? 503 : 200);
});

app.get("/v1/status", async (context) => {
  const states = await context.var.storage.readAllStates();
  const body = { asOf: currentCacheSlice().toISOString(), sources: states };
  context.header("Cache-Control", LATEST_CACHE);
  return context.json(body);
});

app.get("/v1/laundry/head", async (context) => {
  const state = await context.var.storage.readState("laundry");
  if (!state) return context.json({ error: "NO_DATA" }, 503);
  context.header("Cache-Control", LATEST_CACHE);
  return context.json(state);
});

app.get("/v1/laundry/latest", async (context) => {
  const state = await context.var.storage.readState("laundry");
  if (!state?.lastNormalizedKey) return context.json({ error: "NO_DATA" }, 503);
  const version = await context.var.storage.readJson<LaundryVersion>(state.lastNormalizedKey)
    ?? await context.var.storage.readJson<LaundryVersion>("latest/laundry.json");
  if (!version) return context.json({ error: "DATA_OBJECT_MISSING" }, 503);
  const now = currentCacheSlice();
  const body = withLaundryCapacity(projectLaundry(version, state, now, false));
  context.header("Cache-Control", LATEST_CACHE);
  return context.json(body);
});

app.get("/v1/laundry/at", zValidator("query", timeQuerySchema, validationHook), (context) => {
  const parsed = new Date(context.req.valid("query").time);
  const location = `/v1/laundry/minutes/${compactUtcMinute(floorToMinute(parsed))}`;
  context.header("Cache-Control", IMMUTABLE_CACHE);
  return context.redirect(location, 308);
});

app.get("/v1/laundry/minutes/:minute", zValidator("param", minuteParamSchema, validationHook), async (context) => {
  const minute = context.req.valid("param").minute;
  const requested = parseCompactUtcMinute(minute);
  if (!requested) return context.json({ error: "INVALID_MINUTE" }, 400);
  const observation = await context.var.storage.readObservation("laundry", minuteEpoch(requested));
  if (!observation) {
    const expired = requested.getTime() < Date.now() - 90 * 24 * 60 * 60_000;
    return context.json(
      { error: expired ? "HISTORY_EXPIRED" : "OBSERVATION_NOT_FOUND" },
      expired ? 410 : 404,
    );
  }
  if (!observation.normalizedKey) {
    context.header("Cache-Control", IMMUTABLE_CACHE);
    context.header("ETag", `"laundry-minute-${observation.minuteEpoch}-${observation.status}"`);
    return context.json({ minute, observation, data: null });
  }
  const version = await context.var.storage.readJson<LaundryVersion>(observation.normalizedKey);
  if (!version) return context.json({ error: "DATA_OBJECT_MISSING" }, 503);
  const asOf = new Date(observation.collectedAt);
  context.header("Cache-Control", IMMUTABLE_CACHE);
  context.header(
    "ETag",
    `"laundry-minute-${observation.minuteEpoch}-${observation.status}-${observation.versionSha}"`,
  );
  return context.json({
    minute,
    observation,
    data: withLaundryCapacity(projectLaundry(version, historicalState(observation), asOf, true)),
  });
});

app.get("/v1/laundry/versions/:sha", zValidator("param", shaParamSchema, validationHook), async (context) => {
  const sha = context.req.valid("param").sha;
  const version = await context.var.storage.readJson<LaundryVersion>(`versions/laundry/${sha}.json`);
  if (!version) return context.json({ error: "VERSION_NOT_FOUND" }, 404);
  context.header("Cache-Control", IMMUTABLE_CACHE);
  context.header("ETag", `"${sha}"`);
  return context.json(toPublicLaundryVersion(version));
});

app.get("/v1/laundry/events", zValidator("query", eventsQuerySchema, validationHook), async (context) => {
  const { since = null, limit } = context.req.valid("query");
  const events = await context.var.storage.listLaundryEvents(since, limit);
  context.header("Cache-Control", LATEST_CACHE);
  return context.json({ events });
});

app.get("/v1/meals", async (context) => {
  const state = await context.var.storage.readState("meals-include-pinned");
  if (!state?.lastNormalizedKey) return context.json({ error: "NO_DATA" }, 503);
  const storedVersion = await context.var.storage.readJson<MealsVersion>(state.lastNormalizedKey)
    ?? await context.var.storage.readJson<MealsVersion>("latest/meals.json");
  if (!storedVersion) return context.json({ error: "DATA_OBJECT_MISSING" }, 503);
  const version = await withContentShas(storedVersion);
  const recentMenus = await context.var.storage.listMealPosts(null, MEAL_HISTORY_PAGE_SIZE);
  const archivedWeeklyMenus = await context.var.storage.listWeeklyMealMenus(100);
  const currentWeeklyMenus = (await Promise.all(
    version.pinnedMenus.map((post) => weeklyMealMenu(post, version.observedAt)),
  )).filter((menu): menu is WeeklyMealMenu => menu !== null);
  const weeklyMenus = [...new Map(
    [...archivedWeeklyMenus, ...currentWeeklyMenus].map((menu) => [menu.weekKey, menu]),
  ).values()].sort((left, right) => right.weekKey.localeCompare(left.weekKey));
  const currentWeekly = currentWeeklyMealMenu(weeklyMenus, new Date());
  const lastRecentMenu = recentMenus.at(-1);
  const body = {
    asOf: currentCacheSlice().toISOString(),
    lastCheckedAt: state.lastSuccessAt,
    data: {
      ...withAssetUrls(version, context.req.url),
      currentWeeklyMenu: {
        ...currentWeekly,
        post: currentWeekly.post ? withPostAssetUrls(currentWeekly.post, context.req.url) : null,
      },
      recentMenus: recentMenus.map((post) => withPostAssetUrls(post, context.req.url)),
      weeklyMenus: weeklyMenus.map((menu) => ({
        ...menu,
        post: withPostAssetUrls(menu.post, context.req.url),
      })),
      historyNextBefore: recentMenus.length === MEAL_HISTORY_PAGE_SIZE && lastRecentMenu
        ? lastRecentMenu.publishedAt ?? lastRecentMenu.firstSeenAt
        : null,
    },
  };
  context.header("Cache-Control", LATEST_CACHE);
  return context.json(body);
});

app.get("/v1/meals/history", zValidator("query", mealHistoryQuerySchema, validationHook), async (context) => {
  const { before = null, limit } = context.req.valid("query");
  const posts = await context.var.storage.listMealPosts(before, limit);
  const last = posts.at(-1);
  const body = {
    posts: posts.map((post) => withPostAssetUrls(post, context.req.url)),
    nextBefore: posts.length === limit && last ? last.publishedAt ?? last.firstSeenAt : null,
  };
  context.header("Cache-Control", LATEST_CACHE);
  return context.json(body);
});

app.get("/v1/assets/:asset", zValidator("param", assetParamSchema, validationHook), async (context) => {
  const match = /^([a-f0-9]{64})\.([a-z0-9]{1,8})$/.exec(context.req.valid("param").asset);
  if (!match?.[1] || !match[2]) throw new Error("Validated asset parameter did not match");
  const [sha, extension] = [match[1], match[2]];
  const object = await context.var.storage.readObject(`assets/${sha.slice(0, 2)}/${sha}.${extension}`);
  if (!object) return context.json({ error: "ASSET_NOT_FOUND" }, 404);
  const headers = new Headers({ "Cache-Control": IMMUTABLE_CACHE, ETag: `"${sha}"` });
  object.writeHttpMetadata(headers);
  return new Response(object.body, { headers });
});

app.post("/v1/auth/lms/verify", zValidator("json", verifyLmsSchema, validationHook), async (context) => {
  const body = context.req.valid("json");
  const result = await verifyLmsAndIssueDesktopSession({
    installationId: body.installationId,
    cookies: body.cookies,
    gateway: context.var.lmsGateway,
    store: context.var.renewalStore,
    nowEpochMs: Date.now(),
  });
  return context.json(result, 201);
});

app.post("/v1/desktop/heartbeat", zValidator("json", heartbeatSchema, validationHook), async (context) => {
  const principal = await desktopPrincipal(context);
  const body = context.req.valid("json");
  const receivedAtEpochMs = Date.now();
  if (!(await context.var.renewalStore.recordDesktopHeartbeat({
    userId: principal.userId,
    installationId: principal.installationId,
    lmsSessionState: body.lmsSessionState,
    appVersion: body.appVersion,
    nowEpochMs: receivedAtEpochMs,
  }))) return context.json({ error: "DESKTOP_NOT_REGISTERED" }, 409);
  if (body.attendanceNotifications) {
    await context.var.renewalStore.setAttendancePreference(
      principal.userId,
      body.attendanceNotifications,
      receivedAtEpochMs,
    );
  }
  return context.json({ receivedAt: new Date(receivedAtEpochMs).toISOString() });
});

app.post("/v1/pairings", async (context) => {
  const principal = await desktopPrincipal(context);
  return context.json(await createPairing({
    principal,
    store: context.var.renewalStore,
    pairingSecret: requirePairingSecret(context.env),
    publicOrigin: publicOrigin(context.req.url),
    nowEpochMs: Date.now(),
  }), 201);
});

app.post("/v1/pairings/:id/claims",
  zValidator("param", pairingParamSchema, validationHook),
  zValidator("json", qrClaimSchema, validationHook),
  async (context) => {
    const body = context.req.valid("json");
    const result = await claimPairing({
      store: context.var.renewalStore,
      pairingSecret: requirePairingSecret(context.env),
      pairingId: context.req.valid("param").id,
      challenge: body.challenge,
      installationId: body.installationId,
      deviceLabel: body.deviceLabel,
      nowEpochMs: Date.now(),
    });
    return context.json(result, 201);
  },
);

app.post("/v1/pairing-claims", zValidator("json", manualClaimSchema, validationHook), async (context) => {
  const body = context.req.valid("json");
  return context.json(await claimPairing({
    store: context.var.renewalStore,
    pairingSecret: requirePairingSecret(context.env),
    manualCode: body.manualCode,
    installationId: body.installationId,
    deviceLabel: body.deviceLabel,
    nowEpochMs: Date.now(),
  }), 201);
});

app.get("/v1/pairings/:id", zValidator("param", pairingParamSchema, validationHook), async (context) => {
  const principal = await desktopPrincipal(context);
  const pairing = await context.var.renewalStore.getPairing(context.req.valid("param").id);
  if (!pairing || pairing.userId !== principal.userId || pairing.desktopInstallationId !== principal.installationId) {
    return context.json({ error: "PAIRING_NOT_FOUND" }, 404);
  }
  const status = pairingStatusAt(pairing, Date.now());
  return context.json({
    status,
    claim: status === "claimed"
      ? {
          claimId: pairing.id,
          deviceLabel: pairing.mobileLabel,
          confirmationCode: pairing.mobileInstallationId?.slice(-4).toUpperCase() ?? null,
        }
      : null,
  });
});

app.post("/v1/pairings/:id/approve", zValidator("param", pairingParamSchema, validationHook), async (context) => {
  await approvePairing({
    store: context.var.renewalStore,
    principal: await desktopPrincipal(context),
    pairingId: context.req.valid("param").id,
    pairingSecret: requirePairingSecret(context.env),
    nowEpochMs: Date.now(),
  });
  return context.body(null, 204);
});

app.post("/v1/pairings/:id/complete",
  zValidator("param", pairingParamSchema, validationHook),
  zValidator("json", completePairingSchema, validationHook),
  async (context) => {
    const pairingId = context.req.valid("param").id;
    const body = context.req.valid("json");
    if (body.claimId !== undefined && body.claimId !== pairingId) {
      return context.json({ error: "PAIRING_RECEIPT_INVALID" }, 401);
    }
    const result = await completePairing({
      store: context.var.renewalStore,
      pairingId,
      claimReceipt: body.claimReceipt,
      pairingSecret: requirePairingSecret(context.env),
      nowEpochMs: Date.now(),
    });
    setMobileSessionCookie(context, result.token, result.expiresAtEpochMs);
    return context.body(null, 204);
  },
);

app.get("/v1/mobile/session", async (context) => {
  const principal = await privatePrincipal(context);
  if (principal.kind !== "mobile") return context.json({ error: "MOBILE_SESSION_REQUIRED" }, 403);
  const sessions = await context.var.renewalStore.listMobileSessions(principal.userId);
  const current = sessions.find((session) => session.id === principal.sessionId);
  if (!current) return context.json({ error: "AUTHENTICATION_REQUIRED" }, 401);
  return context.json({ authenticated: true, expiresAt: new Date(current.expiresAtEpochMs).toISOString() });
});

app.delete("/v1/mobile/session", async (context) => {
  const principal = await privatePrincipal(context);
  if (principal.kind !== "mobile") return context.json({ error: "MOBILE_SESSION_REQUIRED" }, 403);
  await context.var.renewalStore.revokeMobileSession(principal.userId, principal.sessionId, Date.now());
  clearMobileSessionCookie(context);
  return context.body(null, 204);
});

app.get("/v1/devices", async (context) => {
  const principal = await desktopPrincipal(context);
  const now = Date.now();
  const [sessions, subscriptions] = await Promise.all([
    context.var.renewalStore.listMobileSessions(principal.userId),
    context.var.renewalStore.listActivePushSubscriptions(principal.userId, now),
  ]);
  const pushSessionIds = new Set(subscriptions.map((subscription) => subscription.sessionId));
  return context.json({
    devices: sessions.map((session) => ({
      deviceId: session.id,
      deviceLabel: session.label ?? "모바일 기기",
      installationId: session.installationId,
      createdAt: new Date(session.createdAtEpochMs).toISOString(),
      expiresAt: new Date(session.expiresAtEpochMs).toISOString(),
      lastSeenAt: new Date(session.lastSeenAtEpochMs).toISOString(),
      pushEnabled: pushSessionIds.has(session.id),
      status: session.revokedAtEpochMs !== null ? "revoked" : session.expiresAtEpochMs <= now ? "expired" : "active",
    })),
  });
});

app.delete("/v1/devices/:id", zValidator("param", deviceParamSchema, validationHook), async (context) => {
  const principal = await desktopPrincipal(context);
  if (!(await context.var.renewalStore.revokeMobileSession(principal.userId, context.req.valid("param").id, Date.now()))) {
    return context.json({ error: "DEVICE_NOT_FOUND" }, 404);
  }
  return context.body(null, 204);
});

app.get("/v1/attendance/snapshots", getAttendanceSnapshotRoute);
app.get("/v1/attendance/snapshot", getAttendanceSnapshotRoute);
app.put("/v1/attendance/snapshots", putAttendanceSnapshotRoute);
app.put("/v1/attendance/snapshot", putAttendanceSnapshotRoute);

app.put("/v1/attendance/preferences", zValidator("json", attendancePreferenceSchema, validationHook), async (context) => {
  const principal = await privatePrincipal(context);
  const body = context.req.valid("json");
  const current = await context.var.renewalStore.getAttendancePreference(principal.userId);
  await context.var.renewalStore.setAttendancePreference(principal.userId, {
    morning: body.morning,
    evening: body.evening,
    skipSunday: body.skipSunday ?? current?.skipSunday ?? false,
    skipAttendanceDate: body.skipAttendanceDate === undefined
      ? current?.skipAttendanceDate ?? null
      : body.skipAttendanceDate,
  }, Date.now());
  return context.body(null, 204);
});

app.get("/v1/notifications/inbox", zValidator("query", notificationInboxSchema, validationHook), async (context) => {
  const principal = await privatePrincipal(context);
  const limit = context.req.valid("query").limit;
  const notifications = principal.kind === "desktop"
    ? await context.var.renewalStore.listDesktopInbox(principal.userId, Date.now(), limit)
    : await context.var.renewalStore.listNotificationHistory(principal.userId, limit);
  return context.json({
    notifications: notifications.map((notification) => ({
      id: notification.id,
      kind: notification.kind,
      title: notification.title,
      body: notification.body,
      path: notification.path,
      createdAtEpochMs: notification.createdAtEpochMs,
      expiresAtEpochMs: notification.expiresAtEpochMs,
      attempt: notification.desktopAttempt,
    })),
  });
});

app.post("/v1/notifications/test", zValidator("json", testNotificationSchema, validationHook), async (context) => {
  const principal = await privatePrincipal(context);
  const body = context.req.valid("json");
  if (principal.kind === "mobile" && body.desktopDelivered !== undefined) {
    return context.json({ error: "INVALID_REQUEST" }, 400);
  }

  const now = Date.now();
  const subscriptions = await context.var.renewalStore.listActivePushSubscriptions(principal.userId, now);
  if (principal.kind === "mobile" && subscriptions.length === 0) {
    return context.json({ error: "PUSH_SUBSCRIPTION_REQUIRED" }, 409);
  }
  const sender = subscriptions.length > 0 ? configuredPushSender(context.env) : null;
  if (subscriptions.length > 0 && (!context.env.VAPID_PUBLIC_KEY || !sender)) {
    return context.json({ error: "WEB_PUSH_NOT_CONFIGURED" }, 503);
  }

  const id = crypto.randomUUID();
  const expiresAtEpochMs = now + TEST_NOTIFICATION_TTL_MS;
  const payload = {
    notificationId: id,
    kind: "test",
    title: "Jungle Bell 테스트 알림",
    body: "알림이 정상적으로 연결되었습니다.",
    path: "/dashboard.html#notifications",
    tag: `jungle-bell-test-${principal.sessionId}`,
    createdAtEpochMs: now,
    expiresAtEpochMs,
  };
  const inserted = await context.var.renewalStore.insertNotification({
    id,
    userId: principal.userId,
    sourceEventId: `manual-test:${principal.sessionId}:${Math.floor(now / TEST_NOTIFICATION_RATE_WINDOW_MS)}`,
    kind: "test",
    title: payload.title,
    body: payload.body,
    path: payload.path,
    payloadJson: JSON.stringify(payload),
    createdAtEpochMs: now,
    dueAtEpochMs: now,
    expiresAtEpochMs,
    desktopAttempt: 0,
  });
  if (!inserted) return context.json({ error: "TEST_NOTIFICATION_RATE_LIMITED" }, 429);

  if (principal.kind === "desktop" && body.desktopDelivered === true) {
    const acknowledged = await context.var.renewalStore.acknowledgeNotification(
      principal.userId,
      id,
      "displayed",
      now,
    );
    if (!acknowledged) return context.json({ error: "NOTIFICATION_ACK_REJECTED" }, 409);
  }

  for (const subscription of subscriptions) {
    await context.var.renewalStore.queuePushDelivery(id, subscription.id, now);
  }
  if (sender) await deliverDuePushes(context.var.renewalStore, sender, now);
  return context.json({ notificationId: id, queued: subscriptions.length }, 202);
});

app.post("/v1/notifications/:id/ack",
  zValidator("param", notificationParamSchema, validationHook),
  zValidator("json", notificationAckSchema, validationHook),
  async (context) => {
    const principal = await desktopPrincipal(context);
    const body = context.req.valid("json");
    const now = Date.now();
    if (Math.abs(body.occurredAtEpochMs - now) > ATTENDANCE_CLIENT_CLOCK_SKEW_MS) {
      return context.json({ error: "NOTIFICATION_ACK_TIME_INVALID" }, 400);
    }
    if (!(await context.var.renewalStore.acknowledgeNotification(principal.userId, context.req.valid("param").id, body.outcome, now))) {
      return context.json({ error: "NOTIFICATION_ACK_REJECTED" }, 409);
    }
    return context.body(null, 204);
  },
);

app.get("/v1/push/vapid-public-key", async (context) => {
  const principal = await privatePrincipal(context);
  if (principal.kind !== "mobile") return context.json({ error: "MOBILE_SESSION_REQUIRED" }, 403);
  if (!webPushIsConfigured(context.env)) return context.json({ error: "WEB_PUSH_NOT_CONFIGURED" }, 503);
  return context.json({ publicKey: context.env.VAPID_PUBLIC_KEY });
});

app.put("/v1/push/subscriptions", zValidator("json", pushSubscriptionSchema, validationHook), async (context) => {
  const principal = await privatePrincipal(context);
  if (principal.kind !== "mobile") return context.json({ error: "MOBILE_SESSION_REQUIRED" }, 403);
  if (!webPushIsConfigured(context.env)) return context.json({ error: "WEB_PUSH_NOT_CONFIGURED" }, 503);
  const body = context.req.valid("json");
  const id = `jbps_${await sha256Hex(body.endpoint)}`;
  await context.var.renewalStore.upsertPushSubscription({
    id,
    userId: principal.userId,
    sessionId: principal.sessionId,
    endpoint: body.endpoint,
    p256dh: body.keys.p256dh,
    auth: body.keys.auth,
    createdAtEpochMs: Date.now(),
    revokedAtEpochMs: null,
  });
  return context.json({ subscriptionId: id }, 201);
});

app.delete("/v1/push/subscriptions/:id", zValidator("param", pushParamSchema, validationHook), async (context) => {
  const principal = await privatePrincipal(context);
  if (principal.kind !== "mobile") return context.json({ error: "MOBILE_SESSION_REQUIRED" }, 403);
  if (!(await context.var.renewalStore.revokePushSubscription(principal.userId, context.req.valid("param").id, Date.now()))) {
    return context.json({ error: "PUSH_SUBSCRIPTION_NOT_FOUND" }, 404);
  }
  return context.body(null, 204);
});

app.notFound((context) => context.json({ error: "NOT_FOUND" }, 404));
app.onError((error, context) => {
  if (error instanceof RenewalError) return context.json({ error: error.code }, error.status);
  if (error instanceof LmsGatewayError) {
    return context.json({ error: error.code === "LMS_UPSTREAM_UNAVAILABLE" ? error.code : "LMS_IDENTITY_VERIFICATION_FAILED" }, 503);
  }
  apiLogger.error("API request failed", {
    method: context.req.method,
    path: context.req.path,
    error: error.message,
  });
  return context.json({ error: "INTERNAL_ERROR" }, 500);
});

export async function runScheduledRenewal(env: Env, nowEpochMs: number): Promise<void> {
  const store = env.RENEWAL_STORE ?? new D1RenewalStore(env.DB);
  await planAttendanceNotifications(store, nowEpochMs);
  await deliverDuePushes(store, configuredPushSender(env), nowEpochMs);
}

export default {
  fetch(request: Request, env: Env, context: ExecutionContext): Response | Promise<Response> {
    return app.fetch(request, env, context);
  },
  scheduled(controller: ScheduledController, env: Env, context: ExecutionContext): void {
    context.waitUntil(runScheduledRenewal(env, Math.max(controller.scheduledTime, Date.now())));
  },
} satisfies ExportedHandler<Env>;
