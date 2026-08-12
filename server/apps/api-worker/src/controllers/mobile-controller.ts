import { Hono } from "hono";
import { clearMobileSessionCookie, mobilePrincipal } from "./auth";
import type { ApiEnvironment } from "./types";

export function createMobileController(): Hono<ApiEnvironment> {
  const app = new Hono<ApiEnvironment>();
  app.get("/api/mobile/session", async (context) => {
    const principal = await mobilePrincipal(context);
    const session = await context.var.services.mobile.readSession(principal);
    return session ? context.json(session) : context.json({ error: "AUTHENTICATION_REQUIRED" }, 401);
  });
  app.delete("/api/mobile/session", async (context) => {
    const principal = await mobilePrincipal(context);
    await context.var.services.mobile.revokeSession(principal, Date.now());
    clearMobileSessionCookie(context);
    return context.body(null, 204);
  });
  return app;
}
