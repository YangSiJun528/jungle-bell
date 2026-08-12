import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { configuredVapidPublicKey, mobilePrincipal } from "./auth";
import { pushParamSchema, pushSubscriptionSchema, validationHook } from "./schemas";
import type { ApiEnvironment } from "./types";

export function createPushController(): Hono<ApiEnvironment> {
  const app = new Hono<ApiEnvironment>();
  app.get("/api/push/vapid-public-key", async (context) => {
    await mobilePrincipal(context);
    const publicKey = configuredVapidPublicKey(context.env);
    return publicKey
      ? context.json({ publicKey })
      : context.json({ error: "WEB_PUSH_NOT_CONFIGURED" }, 503);
  });
  app.put("/api/push/subscriptions", zValidator("json", pushSubscriptionSchema, validationHook), async (context) => {
    const principal = await mobilePrincipal(context);
    if (!configuredVapidPublicKey(context.env)) return context.json({ error: "WEB_PUSH_NOT_CONFIGURED" }, 503);
    return context.json(await context.var.services.push.subscribe(
      principal,
      context.req.valid("json"),
      Date.now(),
    ), 201);
  });
  app.delete("/api/push/subscriptions/:id", zValidator("param", pushParamSchema, validationHook), async (context) => {
    const principal = await mobilePrincipal(context);
    return await context.var.services.push.unsubscribe(
      principal.userId,
      context.req.valid("param").id,
      Date.now(),
    ) ? context.body(null, 204) : context.json({ error: "PUSH_SUBSCRIPTION_NOT_FOUND" }, 404);
  });
  return app;
}
