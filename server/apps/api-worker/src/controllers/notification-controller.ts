import { zValidator } from "@hono/zod-validator";
import { Hono, type Context } from "hono";
import type { TestNotificationResult } from "../services/notification-service";
import { desktopPrincipal, mobilePrincipal } from "./auth";
import {
  notificationAckSchema,
  notificationInboxSchema,
  notificationParamSchema,
  testNotificationSchema,
  validationHook,
} from "./schemas";
import type { ApiEnvironment } from "./types";

export function createNotificationController(): Hono<ApiEnvironment> {
  const app = new Hono<ApiEnvironment>();
  app.get("/api/desktop/notifications", zValidator("query", notificationInboxSchema, validationHook), async (context) => {
    const principal = await desktopPrincipal(context);
    return context.json(await context.var.services.notifications.listDesktop(
      principal,
      context.req.valid("query").limit,
      Date.now(),
    ));
  });
  app.get("/api/mobile/notifications", zValidator("query", notificationInboxSchema, validationHook), async (context) => {
    const principal = await mobilePrincipal(context);
    return context.json(await context.var.services.notifications.listMobile(
      principal.userId,
      context.req.valid("query").limit,
    ));
  });
  app.post("/api/desktop/notifications/test", zValidator("json", testNotificationSchema, validationHook), async (context) => {
    return testNotificationResponse(context, await context.var.services.notifications.sendTest(
      await desktopPrincipal(context),
      context.req.valid("json").desktopDelivered,
      Date.now(),
    ));
  });
  app.post("/api/mobile/notifications/test", zValidator("json", testNotificationSchema, validationHook), async (context) => {
    const body = context.req.valid("json");
    if (body.desktopDelivered !== undefined) return context.json({ error: "INVALID_REQUEST" }, 400);
    return testNotificationResponse(context, await context.var.services.notifications.sendTest(
      await mobilePrincipal(context),
      undefined,
      Date.now(),
    ));
  });
  app.post(
    "/api/desktop/notifications/:id/ack",
    zValidator("param", notificationParamSchema, validationHook),
    zValidator("json", notificationAckSchema, validationHook),
    async (context) => {
      const body = context.req.valid("json");
      const result = await context.var.services.notifications.acknowledge(
        await desktopPrincipal(context),
        context.req.valid("param").id,
        body.outcome,
        body.occurredAtEpochMs,
        Date.now(),
      );
      if (result === "invalid-time") return context.json({ error: "NOTIFICATION_ACK_TIME_INVALID" }, 400);
      if (result === "rejected") return context.json({ error: "NOTIFICATION_ACK_REJECTED" }, 409);
      return context.body(null, 204);
    },
  );
  return app;
}

function testNotificationResponse(context: Context<ApiEnvironment>, result: TestNotificationResult): Response {
  if (result.status === "push-required") return context.json({ error: "PUSH_SUBSCRIPTION_REQUIRED" }, 409);
  if (result.status === "rate-limited") return context.json({ error: "TEST_NOTIFICATION_RATE_LIMITED" }, 429);
  if (result.status === "ack-rejected") return context.json({ error: "NOTIFICATION_ACK_REJECTED" }, 409);
  return context.json({ notificationId: result.notificationId, queued: result.queued }, 202);
}
