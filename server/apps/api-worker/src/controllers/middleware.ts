import { cache } from "hono/cache";
import { cors } from "hono/cors";
import { etag } from "hono/etag";
import type { Hono } from "hono";
import { configureServerLogging } from "@jungle-bell/backend-common/observability/logging";
import { D1RenewalStore } from "@jungle-bell/backend-common/persistence/d1-renewal-store";
import { createApiServices } from "../services/api-services";
import { CloudflareApiStorage } from "../storage/cloudflare/cloudflare-storage";
import { publicOrigin } from "./auth";
import { isDesktopUiOrigin } from "../services/desktop-ui-session-service";
import type { ApiEnvironment } from "./types";

function isPublicApiPath(path: string): boolean {
  return path.startsWith("/api/public/");
}

function isDesktopUiApiPath(path: string): boolean {
  return path === "/api/desktop-ui" || path.startsWith("/api/desktop-ui/");
}

export function registerApiMiddleware(app: Hono<ApiEnvironment>): void {
  app.use("*", async (_context, next) => {
    await configureServerLogging();
    await next();
  });

  const publicCors = cors({ origin: "*", allowMethods: ["GET", "HEAD", "OPTIONS"], maxAge: 86_400 });
  const privateCors = cors({
    origin: (_origin, context) => publicOrigin(context.req.url),
    allowMethods: ["DELETE", "GET", "HEAD", "OPTIONS", "POST", "PUT"],
    allowHeaders: ["Authorization", "Content-Type"], credentials: true, maxAge: 86_400,
  });
  const desktopUiCors = cors({
    origin: (origin) => isDesktopUiOrigin(origin) ? origin : "",
    allowMethods: ["DELETE", "GET", "HEAD", "OPTIONS", "POST", "PUT"],
    allowHeaders: ["Authorization", "Content-Type"],
    maxAge: 86_400,
  });
  app.use("/api/*", (context, next) => {
    if (isPublicApiPath(context.req.path)) return publicCors(context, next);
    if (isDesktopUiApiPath(context.req.path)) return desktopUiCors(context, next);
    return privateCors(context, next);
  });
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
    const publicStorage = new CloudflareApiStorage(context.env.DB, context.env.DATA_BUCKET);
    const renewalStore = context.env.RENEWAL_STORE ?? new D1RenewalStore(context.env.DB);
    context.set("services", createApiServices(renewalStore, publicStorage));
    await next();
  });
  app.use("/api/*", async (context, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(context.req.method)) return next();
    const origin = context.req.header("Origin");
    if (isDesktopUiApiPath(context.req.path)) {
      return isDesktopUiOrigin(origin)
        ? next()
        : context.json({ error: "ORIGIN_NOT_ALLOWED" }, 403);
    }
    if (origin === undefined || origin === publicOrigin(context.req.url)) return next();
    return context.json({ error: "ORIGIN_NOT_ALLOWED" }, 403);
  });
}
