import { cache } from "hono/cache";
import { cors } from "hono/cors";
import { etag } from "hono/etag";
import type { Hono } from "hono";
import { configureWorkerLogging } from "../workers/logging";
import { CloudflareApiStorage } from "../workers/cloudflare-storage";
import { D1RenewalStore } from "../workers/account-storage";
import { publicOrigin } from "./auth";
import type { ApiEnvironment } from "./types";

function isPublicApiPath(path: string): boolean {
  return path.startsWith("/api/public/");
}

export function registerApiMiddleware(app: Hono<ApiEnvironment>): void {
  app.use("*", async (_context, next) => {
    await configureWorkerLogging();
    await next();
  });

  const publicCors = cors({ origin: "*", allowMethods: ["GET", "HEAD", "OPTIONS"], maxAge: 86_400 });
  const privateCors = cors({
    origin: (_origin, context) => publicOrigin(context.req.url),
    allowMethods: ["DELETE", "GET", "HEAD", "OPTIONS", "POST", "PUT"],
    allowHeaders: ["Authorization", "Content-Type"], credentials: true, maxAge: 86_400,
  });
  app.use("/api/*", (context, next) => isPublicApiPath(context.req.path)
    ? publicCors(context, next)
    : privateCors(context, next));
  app.use("/api/*", etag());

  const publicApiCache = cache({ cacheName: "jungle-bell-api", onCacheNotAvailable: false });
  app.use("/api/*", async (context, next) => {
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
    await next();
  });
  app.use("/api/*", async (context, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(context.req.method)) return next();
    const origin = context.req.header("Origin");
    if (origin === undefined || origin === publicOrigin(context.req.url)) return next();
    return context.json({ error: "ORIGIN_NOT_ALLOWED" }, 403);
  });
}
