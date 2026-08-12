import type { NotificationRecord, RenewalStore } from "@jungle-bell/backend-common/ports/account-storage";
import { ATTENDANCE_CLIENT_CLOCK_SKEW_MS } from "@jungle-bell/backend-common/renewal/attendance-policy";
import type { Principal } from "../domain/session";

export type NotificationStore = Pick<RenewalStore,
  | "acknowledgeNotification"
  | "insertNotification"
  | "listActivePushSubscriptions"
  | "listDesktopInbox"
  | "listNotificationHistory"
>;

const TEST_NOTIFICATION_RATE_WINDOW_MS = 30_000;
const TEST_NOTIFICATION_TTL_MS = 10 * 60_000;

export type TestNotificationResult =
  | { status: "accepted"; notificationId: string; queued: number }
  | { status: "push-required" }
  | { status: "rate-limited" }
  | { status: "ack-rejected" };

/** Notification inbox, acknowledgement, and manual test workflows. */
export class NotificationService {
  constructor(private readonly store: NotificationStore) {}

  async listDesktop(principal: Principal, limit: number, nowEpochMs: number) {
    const notifications = await this.store.listDesktopInbox(
      principal.userId,
      principal.installationId,
      nowEpochMs,
      limit,
    );
    return { notifications: notifications.map(publicNotification) };
  }

  async listMobile(userId: string, limit: number) {
    const notifications = await this.store.listNotificationHistory(userId, limit);
    return { notifications: notifications.map(publicNotification) };
  }

  async sendTest(
    principal: Principal,
    desktopDelivered: boolean | undefined,
    nowEpochMs: number,
  ): Promise<TestNotificationResult> {
    const subscriptions = await this.store.listActivePushSubscriptions(principal.userId, nowEpochMs);
    if (principal.kind === "mobile" && subscriptions.length === 0) return { status: "push-required" };
    const id = crypto.randomUUID();
    const expiresAtEpochMs = nowEpochMs + TEST_NOTIFICATION_TTL_MS;
    const payload = {
      notificationId: id,
      kind: "test",
      title: "Jungle Bell 테스트 알림",
      body: "알림이 정상적으로 연결되었습니다.",
      path: "/dashboard.html#notifications",
      tag: `jungle-bell-test-${principal.sessionId}`,
      createdAtEpochMs: nowEpochMs,
      expiresAtEpochMs,
    };
    const inserted = await this.store.insertNotification({
      id,
      userId: principal.userId,
      sourceEventId: `manual-test:${principal.sessionId}:${Math.floor(nowEpochMs / TEST_NOTIFICATION_RATE_WINDOW_MS)}`,
      kind: payload.kind,
      title: payload.title,
      body: payload.body,
      path: payload.path,
      payloadJson: JSON.stringify(payload),
      createdAtEpochMs: nowEpochMs,
      dueAtEpochMs: nowEpochMs,
      expiresAtEpochMs,
      desktopAttempt: 0,
    });
    if (!inserted) return { status: "rate-limited" };
    if (principal.kind === "desktop" && desktopDelivered === true
      && !(await this.store.acknowledgeNotification(
        principal.userId,
        principal.installationId,
        id,
        "displayed",
        nowEpochMs,
      ))) return { status: "ack-rejected" };
    return { status: "accepted", notificationId: id, queued: subscriptions.length };
  }

  async acknowledge(
    principal: Principal,
    notificationId: string,
    outcome: "displayed" | "failed",
    occurredAtEpochMs: number,
    nowEpochMs: number,
  ): Promise<"accepted" | "invalid-time" | "rejected"> {
    if (Math.abs(occurredAtEpochMs - nowEpochMs) > ATTENDANCE_CLIENT_CLOCK_SKEW_MS) return "invalid-time";
    return await this.store.acknowledgeNotification(
      principal.userId,
      principal.installationId,
      notificationId,
      outcome,
      nowEpochMs,
    ) ? "accepted" : "rejected";
  }
}

function publicNotification(notification: NotificationRecord) {
  return {
    id: notification.id,
    kind: notification.kind,
    title: notification.title,
    body: notification.body,
    path: notification.path,
    createdAtEpochMs: notification.createdAtEpochMs,
    expiresAtEpochMs: notification.expiresAtEpochMs,
    attempt: notification.desktopAttempt,
  };
}
