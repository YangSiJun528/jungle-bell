import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { desktopPrincipal, rateLimitKey } from "./auth";
import {
  desktopEnrollmentSchema,
  desktopUiSessionSchema,
  deviceParamSchema,
  emptyObjectSchema,
  heartbeatSchema,
  validationHook,
} from "./schemas";
import type { ApiEnvironment } from "./types";

export function createDesktopController(): Hono<ApiEnvironment> {
  const app = new Hono<ApiEnvironment>();
  app.post("/api/desktop/installations", zValidator("json", desktopEnrollmentSchema, validationHook), async (context) => {
    const now = Date.now();
    const installationId = context.req.valid("json").installationId;
    const result = await context.var.services.desktop.enroll(installationId, [
      await rateLimitKey(context, "desktop-enrollment"),
      await rateLimitKey(context, "desktop-enrollment", `installation:${installationId}`),
    ], now);
    return result
      ? context.json(result, 201)
      : context.json({ error: "DESKTOP_ENROLLMENT_RATE_LIMITED" }, 429);
  });

  app.post("/api/desktop/installations/rotate", zValidator("json", emptyObjectSchema, validationHook), async (context) => {
    return context.json(await context.var.services.desktop.rotate(await desktopPrincipal(context), Date.now()));
  });

  app.post(
    "/api/desktop/webview-sessions",
    zValidator("json", desktopUiSessionSchema, validationHook),
    async (context) => context.json(await context.var.services.desktopUiSessions.issue(
      await desktopPrincipal(context),
      context.req.valid("json").origin,
      Date.now(),
    ), 201),
  );

  app.delete(
    "/api/desktop/webview-sessions/current",
    zValidator("json", desktopUiSessionSchema, validationHook),
    async (context) => {
      await context.var.services.desktopUiSessions.revoke(
        await desktopPrincipal(context),
        context.req.valid("json").origin,
      );
      return context.body(null, 204);
    },
  );

  app.post("/api/desktop/heartbeat", zValidator("json", heartbeatSchema, validationHook), async (context) => {
    const result = await context.var.services.desktop.heartbeat(
      await desktopPrincipal(context),
      context.req.valid("json"),
      Date.now(),
    );
    return result ? context.json(result) : context.json({ error: "DESKTOP_NOT_REGISTERED" }, 409);
  });

  app.get("/api/desktop/mobile-sessions", async (context) => {
    const principal = await desktopPrincipal(context);
    return context.json(await context.var.services.desktop.listMobileSessions(principal.userId, Date.now()));
  });

  app.delete("/api/desktop/mobile-sessions/:id", zValidator("param", deviceParamSchema, validationHook), async (context) => {
    const principal = await desktopPrincipal(context);
    if (!(await context.var.services.desktop.revokeMobileSession(
      principal.userId,
      context.req.valid("param").id,
      Date.now(),
    ))) {
      return context.json({ error: "DEVICE_NOT_FOUND" }, 404);
    }
    return context.body(null, 204);
  });
  return app;
}
