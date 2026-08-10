import { zValidator } from "@hono/zod-validator";
import type { Hono } from "hono";
import { enrollDesktop, rotateDesktopCredential } from "../../application/desktop-enrollment";
import { DESKTOP_ENROLLMENT_POLICY } from "../../domain/enrollment-policy";
import { desktopPrincipal, rateLimitKey } from "../auth";
import { desktopEnrollmentSchema, deviceParamSchema, emptyObjectSchema, heartbeatSchema, validationHook } from "../schemas";
import type { ApiEnvironment } from "../types";

export function registerDesktopRoutes(app: Hono<ApiEnvironment>): void {
  app.post("/api/desktop/installations", zValidator("json", desktopEnrollmentSchema, validationHook), async (context) => {
    const now = Date.now();
    const installationId = context.req.valid("json").installationId;
    if (!(await context.var.renewalStore.consumeDesktopEnrollmentAttempt(
      await rateLimitKey(context, "desktop-enrollment"),
      now,
      DESKTOP_ENROLLMENT_POLICY.windowMs,
      DESKTOP_ENROLLMENT_POLICY.ipAttemptLimit,
    )) || !(await context.var.renewalStore.consumeDesktopEnrollmentAttempt(
      await rateLimitKey(context, "desktop-enrollment", `installation:${installationId}`),
      now,
      DESKTOP_ENROLLMENT_POLICY.windowMs,
      DESKTOP_ENROLLMENT_POLICY.installationAttemptLimit,
    ))) {
      return context.json({ error: "DESKTOP_ENROLLMENT_RATE_LIMITED" }, 429);
    }
    return context.json(await enrollDesktop({
      installationId, store: context.var.renewalStore, nowEpochMs: now,
    }), 201);
  });

  app.post("/api/desktop/installations/rotate", zValidator("json", emptyObjectSchema, validationHook), async (context) => {
    return context.json(await rotateDesktopCredential({
      principal: await desktopPrincipal(context), store: context.var.renewalStore, nowEpochMs: Date.now(),
    }));
  });

  app.post("/api/desktop/heartbeat", zValidator("json", heartbeatSchema, validationHook), async (context) => {
    const principal = await desktopPrincipal(context);
    const body = context.req.valid("json");
    const now = Date.now();
    if (!(await context.var.renewalStore.recordDesktopHeartbeat({
      userId: principal.userId, installationId: principal.installationId,
      lmsSessionState: body.lmsSessionState, appVersion: body.appVersion, nowEpochMs: now,
    }))) return context.json({ error: "DESKTOP_NOT_REGISTERED" }, 409);
    return context.json({ receivedAt: new Date(now).toISOString() });
  });

  app.get("/api/desktop/mobile-sessions", async (context) => {
    const principal = await desktopPrincipal(context);
    const now = Date.now();
    const [sessions, subscriptions] = await Promise.all([
      context.var.renewalStore.listMobileSessions(principal.userId),
      context.var.renewalStore.listActivePushSubscriptions(principal.userId, now),
    ]);
    const pushSessionIds = new Set(subscriptions.map((subscription) => subscription.sessionId));
    return context.json({ devices: sessions.map((session) => ({
      deviceId: session.id, deviceLabel: session.label ?? "모바일 기기", installationId: session.installationId,
      createdAt: new Date(session.createdAtEpochMs).toISOString(), expiresAt: new Date(session.expiresAtEpochMs).toISOString(),
      lastSeenAt: new Date(session.lastSeenAtEpochMs).toISOString(), pushEnabled: pushSessionIds.has(session.id),
      status: session.revokedAtEpochMs !== null ? "revoked" : session.expiresAtEpochMs <= now ? "expired" : "active",
    })) });
  });

  app.delete("/api/desktop/mobile-sessions/:id", zValidator("param", deviceParamSchema, validationHook), async (context) => {
    const principal = await desktopPrincipal(context);
    if (!(await context.var.renewalStore.revokeMobileSession(principal.userId, context.req.valid("param").id, Date.now()))) {
      return context.json({ error: "DEVICE_NOT_FOUND" }, 404);
    }
    return context.body(null, 204);
  });
}
