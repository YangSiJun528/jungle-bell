import type { Hono } from "hono";
import { clearMobileSessionCookie, mobilePrincipal } from "../auth";
import type { ApiEnvironment } from "../types";

export function registerMobileRoutes(app: Hono<ApiEnvironment>): void {
  app.get("/api/mobile/session", async (context) => {
    const principal = await mobilePrincipal(context);
    const current = (await context.var.renewalStore.listMobileSessions(principal.userId))
      .find((session) => session.id === principal.sessionId);
    if (!current) return context.json({ error: "AUTHENTICATION_REQUIRED" }, 401);
    return context.json({ authenticated: true, expiresAt: new Date(current.expiresAtEpochMs).toISOString() });
  });
  app.delete("/api/mobile/session", async (context) => {
    const principal = await mobilePrincipal(context);
    await context.var.renewalStore.revokeMobileSession(principal.userId, principal.sessionId, Date.now());
    clearMobileSessionCookie(context);
    return context.body(null, 204);
  });
}
