import { zValidator } from "@hono/zod-validator";
import type { Context, Hono } from "hono";
import { ATTENDANCE_CLIENT_CLOCK_SKEW_MS } from "../../renewal/attendance-policy";
import type { Principal } from "../../renewal/service";
import { desktopPrincipal, mobilePrincipal } from "../auth";
import {
  notificationAckSchema, notificationInboxSchema, notificationParamSchema,
  testNotificationSchema, validationHook,
} from "../schemas";
import type { ApiEnvironment } from "../types";

const TEST_NOTIFICATION_RATE_WINDOW_MS = 30_000;
const TEST_NOTIFICATION_TTL_MS = 10 * 60_000;

export function registerNotificationRoutes(app: Hono<ApiEnvironment>): void {
  app.get("/api/desktop/notifications", zValidator("query", notificationInboxSchema, validationHook), async (context) => {
    const principal = await desktopPrincipal(context);
    const notifications = await context.var.renewalStore.listDesktopInbox(
      principal.userId, principal.installationId, Date.now(), context.req.valid("query").limit,
    );
    return context.json({ notifications: notifications.map(desktopNotification) });
  });
  app.get("/api/mobile/notifications", zValidator("query", notificationInboxSchema, validationHook), async (context) => {
    const principal = await mobilePrincipal(context);
    const notifications = await context.var.renewalStore.listNotificationHistory(principal.userId, context.req.valid("query").limit);
    return context.json({ notifications: notifications.map(mobileNotification) });
  });

  app.post("/api/desktop/notifications/test", zValidator("json", testNotificationSchema, validationHook), async (context) => {
    return sendTestNotification(context, await desktopPrincipal(context), context.req.valid("json").desktopDelivered);
  });
  app.post("/api/mobile/notifications/test", zValidator("json", testNotificationSchema, validationHook), async (context) => {
    const body = context.req.valid("json");
    if (body.desktopDelivered !== undefined) return context.json({ error: "INVALID_REQUEST" }, 400);
    return sendTestNotification(context, await mobilePrincipal(context), undefined);
  });

  app.post("/api/desktop/notifications/:id/ack", zValidator("param", notificationParamSchema, validationHook),
    zValidator("json", notificationAckSchema, validationHook), async (context) => {
      const principal = await desktopPrincipal(context);
      const body = context.req.valid("json");
      const now = Date.now();
      if (Math.abs(body.occurredAtEpochMs - now) > ATTENDANCE_CLIENT_CLOCK_SKEW_MS) {
        return context.json({ error: "NOTIFICATION_ACK_TIME_INVALID" }, 400);
      }
      if (!(await context.var.renewalStore.acknowledgeNotification(
        principal.userId, principal.installationId, context.req.valid("param").id, body.outcome, now,
      ))) return context.json({ error: "NOTIFICATION_ACK_REJECTED" }, 409);
      return context.body(null, 204);
    });
}

async function sendTestNotification(
  context: Context<ApiEnvironment>,
  principal: Principal,
  desktopDelivered: boolean | undefined,
): Promise<Response> {
  const now = Date.now();
  const subscriptions = await context.var.renewalStore.listActivePushSubscriptions(principal.userId, now);
  if (principal.kind === "mobile" && subscriptions.length === 0) {
    return context.json({ error: "PUSH_SUBSCRIPTION_REQUIRED" }, 409);
  }
  const id = crypto.randomUUID();
  const expiresAtEpochMs = now + TEST_NOTIFICATION_TTL_MS;
  const payload = {
    notificationId: id, kind: "test", title: "Jungle Bell 테스트 알림", body: "알림이 정상적으로 연결되었습니다.",
    path: "/dashboard.html#notifications", tag: `jungle-bell-test-${principal.sessionId}`,
    createdAtEpochMs: now, expiresAtEpochMs,
  };
  const inserted = await context.var.renewalStore.insertNotification({
    id, userId: principal.userId,
    sourceEventId: `manual-test:${principal.sessionId}:${Math.floor(now / TEST_NOTIFICATION_RATE_WINDOW_MS)}`,
    kind: payload.kind, title: payload.title, body: payload.body, path: payload.path,
    payloadJson: JSON.stringify(payload), createdAtEpochMs: now, dueAtEpochMs: now,
    expiresAtEpochMs, desktopAttempt: 0,
  });
  if (!inserted) return context.json({ error: "TEST_NOTIFICATION_RATE_LIMITED" }, 429);
  if (principal.kind === "desktop" && desktopDelivered === true
    && !(await context.var.renewalStore.acknowledgeNotification(
      principal.userId, principal.installationId, id, "displayed", now,
    ))) return context.json({ error: "NOTIFICATION_ACK_REJECTED" }, 409);
  return context.json({ notificationId: id, queued: subscriptions.length }, 202);
}

function desktopNotification(notification: Awaited<ReturnType<ApiEnvironment["Variables"]["renewalStore"]["listDesktopInbox"]>>[number]) {
  return {
    id: notification.id, kind: notification.kind, title: notification.title, body: notification.body,
    path: notification.path, createdAtEpochMs: notification.createdAtEpochMs,
    expiresAtEpochMs: notification.expiresAtEpochMs, attempt: notification.desktopAttempt,
  };
}

function mobileNotification(notification: Awaited<ReturnType<ApiEnvironment["Variables"]["renewalStore"]["listNotificationHistory"]>>[number]) {
  return {
    id: notification.id, kind: notification.kind, title: notification.title, body: notification.body,
    path: notification.path, createdAtEpochMs: notification.createdAtEpochMs,
    expiresAtEpochMs: notification.expiresAtEpochMs, attempt: notification.desktopAttempt,
  };
}
