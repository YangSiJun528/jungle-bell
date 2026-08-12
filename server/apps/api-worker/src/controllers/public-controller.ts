import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import {
  assetParamSchema,
  eventsQuerySchema,
  mealHistoryQuerySchema,
  minuteParamSchema,
  shaParamSchema,
  timeQuerySchema,
  validationHook,
} from "./schemas";
import type { ApiEnvironment } from "./types";

const LATEST_CACHE = "public, max-age=15, s-maxage=30, stale-while-revalidate=120";
const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
const SAFE_ASSET_TYPES: Readonly<Record<string, string>> = {
  avif: "image/avif",
  gif: "image/gif",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

export function createPublicController(): Hono<ApiEnvironment> {
  const app = new Hono<ApiEnvironment>();
  app.get("/api/health", async (context) => {
    const result = await context.var.services.publicData.health(Date.now());
    return context.json(result.body, result.degraded ? 503 : 200);
  });
  app.get("/api/public/status", async (context) => {
    context.header("Cache-Control", LATEST_CACHE);
    return context.json(await context.var.services.publicData.status());
  });
  app.get("/api/public/laundry/head", async (context) => {
    const result = await context.var.services.publicData.laundryHead();
    if (!result.ok) return context.json({ error: result.error }, 503);
    context.header("Cache-Control", LATEST_CACHE);
    return context.json(result.value);
  });
  app.get("/api/public/laundry", async (context) => {
    const result = await context.var.services.publicData.laundry();
    if (!result.ok) return context.json({ error: result.error }, 503);
    context.header("Cache-Control", LATEST_CACHE);
    return context.json(result.value);
  });
  app.get("/api/public/laundry/at", zValidator("query", timeQuerySchema, validationHook), (context) => {
    context.header("Cache-Control", IMMUTABLE_CACHE);
    return context.redirect(context.var.services.publicData.laundryMinuteRedirect(context.req.valid("query").time), 308);
  });
  app.get("/api/public/laundry/minutes/:minute", zValidator("param", minuteParamSchema, validationHook), async (context) => {
    const result = await context.var.services.publicData.laundryAtMinute(context.req.valid("param").minute, Date.now());
    if (!result.ok) {
      const status = result.error === "HISTORY_EXPIRED" ? 410
        : result.error === "OBSERVATION_NOT_FOUND" ? 404
          : result.error === "INVALID_MINUTE" ? 400 : 503;
      return context.json({ error: result.error }, status);
    }
    context.header("Cache-Control", IMMUTABLE_CACHE);
    const { observation } = result.value;
    context.header("ETag", result.value.data
      ? `"laundry-minute-${observation.minuteEpoch}-${observation.status}-${observation.versionSha}"`
      : `"laundry-minute-${observation.minuteEpoch}-${observation.status}"`);
    return context.json(result.value);
  });
  app.get("/api/public/laundry/versions/:sha", zValidator("param", shaParamSchema, validationHook), async (context) => {
    const sha = context.req.valid("param").sha;
    const result = await context.var.services.publicData.laundryVersion(sha);
    if (!result.ok) return context.json({ error: result.error }, 404);
    context.header("Cache-Control", IMMUTABLE_CACHE);
    context.header("ETag", `"${sha}"`);
    return context.json(result.value);
  });
  app.get("/api/public/laundry/events", zValidator("query", eventsQuerySchema, validationHook), async (context) => {
    const { since = null, limit } = context.req.valid("query");
    context.header("Cache-Control", LATEST_CACHE);
    return context.json(await context.var.services.publicData.laundryEvents(since, limit));
  });
  app.get("/api/public/meals", async (context) => {
    const result = await context.var.services.publicData.meals(context.req.url);
    if (!result.ok) return context.json({ error: result.error }, 503);
    context.header("Cache-Control", LATEST_CACHE);
    return context.json(result.value);
  });
  app.get("/api/public/meals/history", zValidator("query", mealHistoryQuerySchema, validationHook), async (context) => {
    const { before, limit } = context.req.valid("query");
    context.header("Cache-Control", LATEST_CACHE);
    return context.json(await context.var.services.publicData.mealHistory(before, limit, context.req.url));
  });
  app.get("/api/public/assets/:asset", zValidator("param", assetParamSchema, validationHook), async (context) => {
    const result = await context.var.services.publicData.asset(context.req.valid("param").asset);
    if (!result.ok) return context.json({ error: result.error }, 404);
    const contentType = SAFE_ASSET_TYPES[result.value.extension];
    if (!contentType) return context.json({ error: "ASSET_NOT_FOUND" }, 404);
    const headers = new Headers({ "Cache-Control": IMMUTABLE_CACHE, ETag: `"${result.value.sha}"` });
    result.value.object.writeHttpMetadata(headers);
    headers.set("Content-Type", contentType);
    headers.set("Content-Security-Policy", "default-src 'none'; sandbox");
    headers.set("Cross-Origin-Resource-Policy", "cross-origin");
    headers.set("X-Content-Type-Options", "nosniff");
    return new Response(result.value.object.body, { headers });
  });
  return app;
}
