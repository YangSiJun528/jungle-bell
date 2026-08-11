import { zValidator } from "@hono/zod-validator";
import type { Hono } from "hono";
import { toPublicLaundryVersion, type LaundryVersion } from "../../collector/laundry";
import { withLaundryCapacity } from "../../collector/laundry-capacity";
import {
  currentWeeklyMealMenu, weeklyMealMenu, withMealPostContentSha,
  type MealsVersion, type WeeklyMealMenu,
} from "../../collector/meals";
import { projectLaundry } from "../../collector/projection";
import { compactUtcMinute, floorToMinute, minuteEpoch, parseCompactUtcMinute } from "../../collector/time";
import { SOURCE_NAMES, type SourceName, type SourceState } from "../../collector/types";
import { decodeMealHistoryCursor, encodeMealHistoryCursor } from "../../domain/meal-history";
import type { CloudflareApiStorage } from "../../workers/cloudflare-storage";
import {
  assetParamSchema, eventsQuerySchema, mealHistoryQuerySchema, minuteParamSchema,
  shaParamSchema, timeQuerySchema, validationHook,
} from "../schemas";
import type { ApiEnvironment } from "../types";

const LATEST_CACHE = "public, max-age=15, s-maxage=30, stale-while-revalidate=120";
const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
const MEAL_HISTORY_PAGE_SIZE = 30;
const SAFE_ASSET_TYPES: Readonly<Record<string, string>> = {
  avif: "image/avif", gif: "image/gif", jpg: "image/jpeg", jpeg: "image/jpeg",
  png: "image/png", webp: "image/webp",
};
const MAX_SOURCE_AGE_MS: Record<SourceName, number> = {
  laundry: 3 * 60_000, "meals-include-pinned": 12 * 60_000, "meals-default": 12 * 60_000,
};

export function registerPublicRoutes(app: Hono<ApiEnvironment>): void {
  app.get("/api/health", async (context) => {
    const states = await context.var.storage.readAllStates();
    const now = Date.now();
    const degraded = states.length !== SOURCE_NAMES.length || states.some((state) =>
      !state.lastSuccessAt || now - Date.parse(state.lastSuccessAt) > MAX_SOURCE_AGE_MS[state.source]
      || state.consecutiveFailures >= 3);
    return context.json({ status: degraded ? "DEGRADED" : "OK", checkedAt: new Date(now).toISOString(), sources: states },
      degraded ? 503 : 200);
  });

  app.get("/api/public/status", async (context) => {
    const body = { asOf: currentCacheSlice().toISOString(), sources: await context.var.storage.readAllStates() };
    context.header("Cache-Control", LATEST_CACHE);
    return context.json(body);
  });
  app.get("/api/public/laundry/head", async (context) => {
    const state = await context.var.storage.readState("laundry");
    if (!state) return context.json({ error: "NO_DATA" }, 503);
    context.header("Cache-Control", LATEST_CACHE);
    return context.json(state);
  });
  app.get("/api/public/laundry", async (context) => {
    const state = await context.var.storage.readState("laundry");
    if (!state?.lastNormalizedKey) return context.json({ error: "NO_DATA" }, 503);
    const version = await context.var.storage.readJson<LaundryVersion>(state.lastNormalizedKey)
      ?? await context.var.storage.readJson<LaundryVersion>("latest/laundry.json");
    if (!version) return context.json({ error: "DATA_OBJECT_MISSING" }, 503);
    context.header("Cache-Control", LATEST_CACHE);
    return context.json(withLaundryCapacity(projectLaundry(version, state, currentCacheSlice(), false)));
  });
  app.get("/api/public/laundry/at", zValidator("query", timeQuerySchema, validationHook), (context) => {
    const parsed = new Date(context.req.valid("query").time);
    context.header("Cache-Control", IMMUTABLE_CACHE);
    return context.redirect(`/api/public/laundry/minutes/${compactUtcMinute(floorToMinute(parsed))}`, 308);
  });
  app.get("/api/public/laundry/minutes/:minute", zValidator("param", minuteParamSchema, validationHook), async (context) => {
    const minute = context.req.valid("param").minute;
    const requested = parseCompactUtcMinute(minute);
    if (!requested) return context.json({ error: "INVALID_MINUTE" }, 400);
    const observation = await context.var.storage.readObservation("laundry", minuteEpoch(requested));
    if (!observation) {
      const expired = requested.getTime() < Date.now() - 90 * 24 * 60 * 60_000;
      return context.json({ error: expired ? "HISTORY_EXPIRED" : "OBSERVATION_NOT_FOUND" }, expired ? 410 : 404);
    }
    context.header("Cache-Control", IMMUTABLE_CACHE);
    if (!observation.normalizedKey) {
      context.header("ETag", `"laundry-minute-${observation.minuteEpoch}-${observation.status}"`);
      return context.json({ minute, observation, data: null });
    }
    const version = await context.var.storage.readJson<LaundryVersion>(observation.normalizedKey);
    if (!version) return context.json({ error: "DATA_OBJECT_MISSING" }, 503);
    context.header("ETag", `"laundry-minute-${observation.minuteEpoch}-${observation.status}-${observation.versionSha}"`);
    return context.json({
      minute, observation,
      data: withLaundryCapacity(projectLaundry(version, historicalState(observation), new Date(observation.collectedAt), true)),
    });
  });
  app.get("/api/public/laundry/versions/:sha", zValidator("param", shaParamSchema, validationHook), async (context) => {
    const sha = context.req.valid("param").sha;
    const version = await context.var.storage.readJson<LaundryVersion>(`versions/laundry/${sha}.json`);
    if (!version) return context.json({ error: "VERSION_NOT_FOUND" }, 404);
    context.header("Cache-Control", IMMUTABLE_CACHE);
    context.header("ETag", `"${sha}"`);
    return context.json(toPublicLaundryVersion(version));
  });
  app.get("/api/public/laundry/events", zValidator("query", eventsQuerySchema, validationHook), async (context) => {
    const { since = null, limit } = context.req.valid("query");
    context.header("Cache-Control", LATEST_CACHE);
    return context.json({ events: await context.var.storage.listLaundryEvents(since, limit) });
  });

  app.get("/api/public/meals", async (context) => {
    const state = await context.var.storage.readState("meals-include-pinned");
    if (!state?.lastNormalizedKey) return context.json({ error: "NO_DATA" }, 503);
    const stored = await context.var.storage.readJson<MealsVersion>(state.lastNormalizedKey)
      ?? await context.var.storage.readJson<MealsVersion>("latest/meals.json");
    if (!stored) return context.json({ error: "DATA_OBJECT_MISSING" }, 503);
    const version = await withContentShas(stored);
    const recentMenus = await context.var.storage.listMealPosts(null, MEAL_HISTORY_PAGE_SIZE);
    const archived = await context.var.storage.listWeeklyMealMenus(100);
    const current = (await Promise.all(version.pinnedMenus.map((post) => weeklyMealMenu(post, version.observedAt))))
      .filter((menu): menu is WeeklyMealMenu => menu !== null);
    const weeklyMenus = [...new Map([...archived, ...current].map((menu) => [menu.weekKey, menu])).values()]
      .sort((left, right) => right.weekKey.localeCompare(left.weekKey));
    const currentWeekly = currentWeeklyMealMenu(weeklyMenus, new Date());
    const last = recentMenus.at(-1);
    context.header("Cache-Control", LATEST_CACHE);
    return context.json({
      asOf: currentCacheSlice().toISOString(), lastCheckedAt: state.lastSuccessAt,
      data: {
        ...withAssetUrls(version, context.req.url),
        currentWeeklyMenu: { ...currentWeekly, post: currentWeekly.post ? withPostAssetUrls(currentWeekly.post, context.req.url) : null },
        recentMenus: recentMenus.map((post) => withPostAssetUrls(post, context.req.url)),
        weeklyMenus: weeklyMenus.map((menu) => ({ ...menu, post: withPostAssetUrls(menu.post, context.req.url) })),
        historyNextBefore: recentMenus.length === MEAL_HISTORY_PAGE_SIZE && last
          ? encodeMealHistoryCursor(last)
          : null,
      },
    });
  });
  app.get("/api/public/meals/history", zValidator("query", mealHistoryQuerySchema, validationHook), async (context) => {
    const { before: encodedBefore, limit } = context.req.valid("query");
    const before = encodedBefore ? decodeMealHistoryCursor(encodedBefore) : null;
    if (encodedBefore && !before) throw new Error("Validated meal history cursor could not be decoded");
    const posts = await context.var.storage.listMealPosts(before, limit);
    const last = posts.at(-1);
    context.header("Cache-Control", LATEST_CACHE);
    return context.json({
      posts: posts.map((post) => withPostAssetUrls(post, context.req.url)),
      nextBefore: posts.length === limit && last ? encodeMealHistoryCursor(last) : null,
    });
  });
  app.get("/api/public/assets/:asset", zValidator("param", assetParamSchema, validationHook), async (context) => {
    const match = /^([a-f0-9]{64})\.([a-z0-9]{1,8})$/.exec(context.req.valid("param").asset);
    if (!match?.[1] || !match[2]) throw new Error("Validated asset parameter did not match");
    const [sha, extension] = [match[1], match[2]];
    const contentType = SAFE_ASSET_TYPES[extension];
    if (!contentType) return context.json({ error: "ASSET_NOT_FOUND" }, 404);
    const object = await context.var.storage.readObject(`assets/${sha.slice(0, 2)}/${sha}.${extension}`);
    if (!object) return context.json({ error: "ASSET_NOT_FOUND" }, 404);
    const headers = new Headers({ "Cache-Control": IMMUTABLE_CACHE, ETag: `"${sha}"` });
    object.writeHttpMetadata(headers);
    headers.set("Content-Type", contentType);
    headers.set("Content-Security-Policy", "default-src 'none'; sandbox");
    headers.set("Cross-Origin-Resource-Policy", "cross-origin");
    headers.set("X-Content-Type-Options", "nosniff");
    return new Response(object.body, { headers });
  });
}

function currentCacheSlice(): Date {
  return new Date(Math.floor(Date.now() / 30_000) * 30_000);
}

function historicalState(observation: Awaited<ReturnType<CloudflareApiStorage["readObservation"]>>): SourceState | null {
  if (!observation) return null;
  return {
    source: "laundry", lastAttemptAt: observation.collectedAt,
    lastSuccessAt: observation.status === "SUCCESS" ? observation.collectedAt : null,
    lastResponseSha: observation.versionSha, lastRawKey: observation.rawKey,
    lastNormalizedKey: observation.normalizedKey, versionFirstSeenAt: observation.versionFirstSeenAt,
    consecutiveFailures: observation.status === "SUCCESS" ? 0 : 1, lastError: observation.error,
  };
}

function withPostAssetUrls<T extends MealsVersion["dailyMenus"][number]>(post: T, requestUrl: string): T {
  const origin = new URL(requestUrl).origin;
  return { ...post, images: post.images.map((image) => ({
    ...image, url: `${origin}/api/public/assets/${image.sha}.${image.extension}`,
  })) };
}

function withAssetUrls(meals: MealsVersion, requestUrl: string): MealsVersion {
  const mapPost = (post: MealsVersion["pinnedMenus"][number]) => withPostAssetUrls(post, requestUrl);
  return { ...meals, pinnedMenus: meals.pinnedMenus.map(mapPost), dailyMenus: meals.dailyMenus.map(mapPost), otherPosts: meals.otherPosts.map(mapPost) };
}

async function withContentShas(meals: MealsVersion): Promise<MealsVersion> {
  return {
    ...meals, schemaVersion: 2,
    pinnedMenus: await Promise.all(meals.pinnedMenus.map(withMealPostContentSha)),
    dailyMenus: await Promise.all(meals.dailyMenus.map(withMealPostContentSha)),
    otherPosts: await Promise.all(meals.otherPosts.map(withMealPostContentSha)),
  };
}
