import { zValidator } from "@hono/zod-validator";
import type { Hono } from "hono";
import { sha256Hex } from "../../renewal/crypto";
import { configuredVapidPublicKey, mobilePrincipal } from "../auth";
import { pushParamSchema, pushSubscriptionSchema, validationHook } from "../schemas";
import type { ApiEnvironment } from "../types";

export function registerPushRoutes(app: Hono<ApiEnvironment>): void {
  app.get("/api/push/vapid-public-key", async (context) => {
    await mobilePrincipal(context);
    const publicKey = configuredVapidPublicKey(context.env);
    if (!publicKey) return context.json({ error: "WEB_PUSH_NOT_CONFIGURED" }, 503);
    return context.json({ publicKey });
  });
  app.put("/api/push/subscriptions", zValidator("json", pushSubscriptionSchema, validationHook), async (context) => {
    const principal = await mobilePrincipal(context);
    if (!configuredVapidPublicKey(context.env)) return context.json({ error: "WEB_PUSH_NOT_CONFIGURED" }, 503);
    const body = context.req.valid("json");
    const id = `jbps_${await sha256Hex(body.endpoint)}`;
    await context.var.renewalStore.upsertPushSubscription({
      id, userId: principal.userId, sessionId: principal.sessionId, endpoint: body.endpoint,
      p256dh: body.keys.p256dh, auth: body.keys.auth, createdAtEpochMs: Date.now(), revokedAtEpochMs: null,
    });
    return context.json({ subscriptionId: id }, 201);
  });
  app.delete("/api/push/subscriptions/:id", zValidator("param", pushParamSchema, validationHook), async (context) => {
    const principal = await mobilePrincipal(context);
    if (!(await context.var.renewalStore.revokePushSubscription(principal.userId, context.req.valid("param").id, Date.now()))) {
      return context.json({ error: "PUSH_SUBSCRIPTION_NOT_FOUND" }, 404);
    }
    return context.body(null, 204);
  });
}
