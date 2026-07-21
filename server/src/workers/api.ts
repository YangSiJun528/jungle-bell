import { zValidator, type Hook } from "@hono/zod-validator";
import { configure, getLogger } from "@logtape/logtape";
import { Hono, type Env as HonoEnvironment } from "hono";
import { cache } from "hono/cache";
import { cors } from "hono/cors";
import { etag } from "hono/etag";
import { z } from "zod";
import { toPublicLaundryVersion, type LaundryVersion } from "../collector/laundry";
import type { MealsVersion } from "../collector/meals";
import { projectLaundry } from "../collector/projection";
import {
  compactUtcMinute,
  floorToMinute,
  minuteEpoch,
  parseCompactUtcMinute,
} from "../collector/time";
import { SOURCE_NAMES, type SourceState } from "../collector/types";
import { CloudflareStorage } from "./cloudflare-storage";
import { getCloudflareConsoleSink } from "./logging";

interface Env {
  DB: D1Database;
  DATA_BUCKET: R2Bucket;
}

type Variables = { storage: CloudflareStorage };
type AppEnvironment = { Bindings: Env; Variables: Variables };

const app = new Hono<AppEnvironment>();
const LATEST_CACHE = "public, max-age=15, s-maxage=30, stale-while-revalidate=120";
const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
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
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
const assetParamSchema = z.object({ asset: z.string().regex(/^[a-f0-9]{64}\.[a-z0-9]{1,8}$/) });

let loggingConfigured: Promise<void> | null = null;

function configureLogging(): Promise<void> {
  loggingConfigured ??= configure({
    sinks: { cloudflare: getCloudflareConsoleSink() },
    loggers: [
      { category: ["jungle-bell"], lowestLevel: "info", sinks: ["cloudflare"] },
      { category: ["logtape"], lowestLevel: "error", sinks: ["cloudflare"] },
    ],
  });
  return loggingConfigured;
}

function currentCacheSlice(): Date {
  return new Date(Math.floor(Date.now() / 30_000) * 30_000);
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

function historicalState(observation: Awaited<ReturnType<CloudflareStorage["readObservation"]>>): SourceState | null {
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

app.use("*", async (_context, next) => {
  await configureLogging();
  await next();
});

app.use("/v1/*", cors({ origin: "*", allowMethods: ["GET", "HEAD", "OPTIONS"], maxAge: 86_400 }));

app.use("/v1/*", etag());
app.use("/v1/*", cache({
  cacheName: "jungle-bell-api-v1",
  onCacheNotAvailable: false,
}));

app.use("*", async (context, next) => {
  await next();
  if (!context.res.headers.has("Cache-Control")) context.res.headers.set("Cache-Control", "no-store");
});

app.use("*", async (context, next) => {
  context.set("storage", new CloudflareStorage(context.env.DB, context.env.DATA_BUCKET));
  await next();
});

app.get("/healthz", async (context) => {
  const states = await context.var.storage.readAllStates();
  const now = Date.now();
  const degraded = states.length !== SOURCE_NAMES.length || states.some((state) =>
    !state.lastSuccessAt || now - Date.parse(state.lastSuccessAt) > 180_000 || state.consecutiveFailures >= 3
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
  const body = projectLaundry(version, state, now, false);
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
    data: projectLaundry(version, historicalState(observation), asOf, true),
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
  const version = await context.var.storage.readJson<MealsVersion>(state.lastNormalizedKey)
    ?? await context.var.storage.readJson<MealsVersion>("latest/meals.json");
  if (!version) return context.json({ error: "DATA_OBJECT_MISSING" }, 503);
  const recentMenus = await context.var.storage.listMealPosts(null, 30);
  const body = {
    asOf: currentCacheSlice().toISOString(),
    lastCheckedAt: state.lastSuccessAt,
    data: {
      ...withAssetUrls(version, context.req.url),
      recentMenus: recentMenus.map((post) => withPostAssetUrls(post, context.req.url)),
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

app.notFound((context) => context.json({ error: "NOT_FOUND" }, 404));
app.onError((error, context) => {
  getLogger(["jungle-bell", "api-worker"]).error("API request failed", {
    method: context.req.method,
    path: context.req.path,
    error: error.message,
  });
  return context.json({ error: "INTERNAL_ERROR" }, 500);
});

export default app;
