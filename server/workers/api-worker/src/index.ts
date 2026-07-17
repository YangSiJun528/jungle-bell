import { zValidator, type Hook } from "@hono/zod-validator";
import { configure, getLogger } from "@logtape/logtape";
import { Hono, type Env as HonoEnvironment } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { canonicalJsonSha256 } from "../../../packages/collector-core/src/hash";
import type { LaundryVersion } from "../../../packages/collector-core/src/laundry";
import type { MealsVersion } from "../../../packages/collector-core/src/meals";
import { projectLaundry, withLaundryEventLabelKo } from "../../../packages/collector-core/src/projection";
import {
  compactUtcMinute,
  floorToMinute,
  minuteEpoch,
  parseCompactUtcMinute,
} from "../../../packages/collector-core/src/time";
import { SOURCE_NAMES, type SourceState } from "../../../packages/collector-core/src/types";
import { getCloudflareConsoleSink } from "../../../packages/logging/src";
import { CloudflareStorage } from "../../../packages/storage-cloudflare/src";

interface Env {
  DB: D1Database;
  DATA_BUCKET: R2Bucket;
}

type Variables = { storage: CloudflareStorage };
type AppEnvironment = { Bindings: Env; Variables: Variables };

const app = new Hono<AppEnvironment>();
const LATEST_CACHE = "public, max-age=15, s-maxage=30, stale-while-revalidate=120";
const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
const rfc3339Schema = z.string().refine((value) => !Number.isNaN(Date.parse(value)), "Expected RFC3339 date-time");
const timeQuerySchema = z.object({ time: rfc3339Schema });
const minuteParamSchema = z.object({ minute: z.string().regex(/^\d{8}T\d{4}Z$/) });
const shaParamSchema = z.object({ sha: z.string().regex(/^[a-f0-9]{64}$/) });
const eventsQuerySchema = z.object({
  since: rfc3339Schema.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
const assetParamSchema = z.object({ asset: z.string().regex(/^[a-f0-9]{64}\.[a-z0-9]{1,8}$/) });
const edgeCache = (caches as unknown as {
  default: {
    match(request: Request): Promise<Response | undefined>;
    put(request: Request, response: Response): Promise<void>;
  };
}).default;

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

function jsonResponse(
  request: Request,
  body: unknown,
  options: { status?: number; cacheControl?: string; etag?: string } = {},
): Response {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": options.cacheControl ?? "no-store",
  });
  if (options.etag) {
    const etag = `"${options.etag}"`;
    headers.set("ETag", etag);
    if (request.headers.get("If-None-Match") === etag) return new Response(null, { status: 304, headers });
  }
  return new Response(JSON.stringify(body), { status: options.status ?? 200, headers });
}

const validationHook: Hook<unknown, HonoEnvironment, string> = (result, context) => {
  if (result.success) return;
  return jsonResponse(context.req.raw, {
    error: "INVALID_REQUEST",
    issues: result.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    })),
  }, { status: 400 });
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

function withAssetUrls(meals: MealsVersion, requestUrl: string): MealsVersion {
  const origin = new URL(requestUrl).origin;
  const mapPost = (post: MealsVersion["pinnedMenus"][number]) => ({
    ...post,
    images: post.images.map((image) => ({
      ...image,
      url: `${origin}/v1/assets/${image.sha}.${image.extension}`,
    })),
  });
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

app.use("/v1/*", async (context, next) => {
  if (context.req.method !== "GET") return next();
  const cached = await edgeCache.match(context.req.raw);
  if (cached) {
    context.res = cached;
    return;
  }
  await next();
  const cacheControl = context.res.headers.get("Cache-Control") ?? "";
  if (context.res.status < 400 && cacheControl.startsWith("public")) {
    context.executionCtx.waitUntil(edgeCache.put(context.req.raw, context.res.clone()));
  }
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
  return jsonResponse(context.req.raw, {
    status: degraded ? "DEGRADED" : "OK",
    checkedAt: new Date(now).toISOString(),
    sources: states,
  }, { status: degraded ? 503 : 200 });
});

app.get("/v1/status", async (context) => {
  const states = await context.var.storage.readAllStates();
  const body = { asOf: currentCacheSlice().toISOString(), sources: states };
  return jsonResponse(context.req.raw, body, {
    cacheControl: LATEST_CACHE,
    etag: await canonicalJsonSha256(body),
  });
});

app.get("/v1/laundry/head", async (context) => {
  const state = await context.var.storage.readState("laundry");
  if (!state) return jsonResponse(context.req.raw, { error: "NO_DATA" }, { status: 503 });
  return jsonResponse(context.req.raw, state, {
    cacheControl: LATEST_CACHE,
    etag: await canonicalJsonSha256(state),
  });
});

app.get("/v1/laundry/latest", async (context) => {
  const state = await context.var.storage.readState("laundry");
  if (!state?.lastNormalizedKey) return jsonResponse(context.req.raw, { error: "NO_DATA" }, { status: 503 });
  const version = await context.var.storage.readJson<LaundryVersion>(state.lastNormalizedKey)
    ?? await context.var.storage.readJson<LaundryVersion>("latest/laundry.json");
  if (!version) return jsonResponse(context.req.raw, { error: "DATA_OBJECT_MISSING" }, { status: 503 });
  const now = currentCacheSlice();
  const body = projectLaundry(version, state, now, false);
  return jsonResponse(context.req.raw, body, {
    cacheControl: LATEST_CACHE,
    etag: await canonicalJsonSha256(body),
  });
});

app.get("/v1/laundry/at", zValidator("query", timeQuerySchema, validationHook), (context) => {
  const parsed = new Date(context.req.valid("query").time);
  const location = `/v1/laundry/minutes/${compactUtcMinute(floorToMinute(parsed))}`;
  return new Response(null, {
    status: 308,
    headers: { Location: location, "Cache-Control": IMMUTABLE_CACHE },
  });
});

app.get("/v1/laundry/minutes/:minute", zValidator("param", minuteParamSchema, validationHook), async (context) => {
  const minute = context.req.valid("param").minute;
  const requested = parseCompactUtcMinute(minute);
  if (!requested) return jsonResponse(context.req.raw, { error: "INVALID_MINUTE" }, { status: 400 });
  const observation = await context.var.storage.readObservation("laundry", minuteEpoch(requested));
  if (!observation) {
    const expired = requested.getTime() < Date.now() - 90 * 24 * 60 * 60_000;
    return jsonResponse(context.req.raw, { error: expired ? "HISTORY_EXPIRED" : "OBSERVATION_NOT_FOUND" }, {
      status: expired ? 410 : 404,
    });
  }
  if (!observation.normalizedKey) {
    return jsonResponse(context.req.raw, { minute, observation, data: null }, {
      cacheControl: IMMUTABLE_CACHE,
      etag: `laundry-minute-${observation.minuteEpoch}-${observation.status}`,
    });
  }
  const version = await context.var.storage.readJson<LaundryVersion>(observation.normalizedKey);
  if (!version) return jsonResponse(context.req.raw, { error: "DATA_OBJECT_MISSING" }, { status: 503 });
  const asOf = new Date(observation.collectedAt);
  return jsonResponse(context.req.raw, {
    minute,
    observation,
    data: projectLaundry(version, historicalState(observation), asOf, true),
  }, {
    cacheControl: IMMUTABLE_CACHE,
    etag: `laundry-minute-${observation.minuteEpoch}-${observation.status}-${observation.versionSha}`,
  });
});

app.get("/v1/laundry/versions/:sha", zValidator("param", shaParamSchema, validationHook), async (context) => {
  const sha = context.req.valid("param").sha;
  const version = await context.var.storage.readJson<LaundryVersion>(`versions/laundry/${sha}.json`);
  if (!version) return jsonResponse(context.req.raw, { error: "VERSION_NOT_FOUND" }, { status: 404 });
  return jsonResponse(context.req.raw, version, { cacheControl: IMMUTABLE_CACHE, etag: sha });
});

app.get("/v1/laundry/events", zValidator("query", eventsQuerySchema, validationHook), async (context) => {
  const { since = null, limit } = context.req.valid("query");
  const events = await context.var.storage.listLaundryEvents(since, limit);
  const body = { events: events.map(withLaundryEventLabelKo) };
  return jsonResponse(context.req.raw, body, {
    cacheControl: LATEST_CACHE,
    etag: await canonicalJsonSha256(body),
  });
});

app.get("/v1/meals", async (context) => {
  const state = await context.var.storage.readState("meals-include-pinned");
  if (!state?.lastNormalizedKey) return jsonResponse(context.req.raw, { error: "NO_DATA" }, { status: 503 });
  const version = await context.var.storage.readJson<MealsVersion>(state.lastNormalizedKey)
    ?? await context.var.storage.readJson<MealsVersion>("latest/meals.json");
  if (!version) return jsonResponse(context.req.raw, { error: "DATA_OBJECT_MISSING" }, { status: 503 });
  const body = {
    asOf: currentCacheSlice().toISOString(),
    lastCheckedAt: state.lastSuccessAt,
    data: withAssetUrls(version, context.req.url),
  };
  return jsonResponse(context.req.raw, body, {
    cacheControl: LATEST_CACHE,
    etag: await canonicalJsonSha256(body),
  });
});

app.get("/v1/assets/:asset", zValidator("param", assetParamSchema, validationHook), async (context) => {
  const match = /^([a-f0-9]{64})\.([a-z0-9]{1,8})$/.exec(context.req.valid("param").asset);
  if (!match?.[1] || !match[2]) throw new Error("Validated asset parameter did not match");
  const [sha, extension] = [match[1], match[2]];
  const object = await context.var.storage.readObject(`assets/${sha.slice(0, 2)}/${sha}.${extension}`);
  if (!object) return jsonResponse(context.req.raw, { error: "ASSET_NOT_FOUND" }, { status: 404 });
  const headers = new Headers({ "Cache-Control": IMMUTABLE_CACHE, ETag: `"${sha}"` });
  if (context.req.header("If-None-Match") === `"${sha}"`) return new Response(null, { status: 304, headers });
  object.writeHttpMetadata(headers);
  return new Response(object.body, { headers });
});

app.notFound((context) => jsonResponse(context.req.raw, { error: "NOT_FOUND" }, { status: 404 }));
app.onError((error, context) => {
  getLogger(["jungle-bell", "api-worker"]).error("API request failed", {
    method: context.req.method,
    path: context.req.path,
    error: error.message,
  });
  return jsonResponse(context.req.raw, { error: "INTERNAL_ERROR" }, { status: 500 });
});

export default app;
