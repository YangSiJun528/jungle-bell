import type {
  LaundryAppliance, LaundryQueueEntryRecord, LaundryWatchRecord, NotificationRecord,
} from "../workers/account-storage";

export type LaundryLifecycleState = "AVAILABLE" | "BUSY" | "PAUSED" | "ERROR" | "COMPLETED" | "UNKNOWN";

export interface LaundryTransitionEvent {
  sourceEventId: string;
  machineId: string;
  appliance: LaundryAppliance;
  sessionId: string | null;
  previousState: LaundryLifecycleState | null;
  currentState: LaundryLifecycleState;
  remainingMinutes: number | null;
  occurredAtEpochMs: number;
}

export type LaundryNotificationOrigin =
  | { kind: "watch"; id: string }
  | { kind: "queue"; id: string };

export interface PlannedLaundryNotification {
  notification: NotificationRecord;
  origins: LaundryNotificationOrigin[];
}

export const LAUNDRY_QUEUE_AVAILABILITY_TTL_MS = 5 * 60_000;
const LAUNDRY_WATCH_AVAILABILITY_TTL_MS = 6 * 60 * 60_000;

export function planLaundryTransition(
  event: LaundryTransitionEvent,
  watches: readonly LaundryWatchRecord[],
  queueEntry: LaundryQueueEntryRecord | null,
): PlannedLaundryNotification[] {
  const planned = watches.flatMap((watch) => watchNotification(event, watch));
  if (becameAvailable(event) && queueEntry) {
    planned.push(availableNotification(event, queueEntry.userId, { kind: "queue", id: queueEntry.id }));
  }
  const unique = new Map<string, PlannedLaundryNotification>();
  for (const candidate of planned) {
    const key = `${candidate.notification.userId}:${candidate.notification.sourceEventId}`;
    const current = unique.get(key);
    if (current) current.origins.push(...candidate.origins);
    else unique.set(key, candidate);
  }
  return [...unique.values()].map((candidate) => clampQueueAvailabilityExpiry(event, candidate));
}

export function completedLaundryWatchIds(
  event: LaundryTransitionEvent,
  watches: readonly LaundryWatchRecord[],
): string[] {
  return watches.filter((watch) => watchIsTerminal(event, watch)).map((watch) => watch.id);
}

function watchNotification(event: LaundryTransitionEvent, watch: LaundryWatchRecord): PlannedLaundryNotification[] {
  if (becameAvailable(event) && watch.notifyWhenAvailable) {
    return [availableNotification(event, watch.userId, { kind: "watch", id: watch.id })];
  }
  if (becameAvailable(event) && watch.sessionId !== null && sessionMatches(watch, event.sessionId)) {
    return [watchEventNotification(event, watch, "laundry-completed")];
  }
  if (event.currentState === "COMPLETED" && watch.sessionId !== null && sessionMatches(watch, event.sessionId)) {
    return [watchEventNotification(event, watch, "laundry-completed")];
  }
  if ((event.currentState === "ERROR" || event.currentState === "PAUSED")
    && watch.sessionId !== null && sessionMatches(watch, event.sessionId)) {
    return [watchEventNotification(event, watch, "laundry-attention")];
  }
  if (event.currentState === "BUSY" && event.remainingMinutes !== null && event.remainingMinutes > 0
    && event.remainingMinutes <= watch.notifyBeforeMinutes && watch.sessionId !== null
    && sessionMatches(watch, event.sessionId)) {
    return [watchEventNotification(event, watch, "laundry-finishing")];
  }
  return [];
}

function availableNotification(
  event: LaundryTransitionEvent,
  userId: string,
  origin: LaundryNotificationOrigin,
): PlannedLaundryNotification {
  const title = `${deviceLabel(event.appliance)} 사용 가능`;
  const body = `${machineLabel(event.machineId)} ${deviceLabel(event.appliance)}를 사용할 수 있습니다.`;
  return plannedNotification(event, userId, "laundry-available", `laundry-available:${event.sourceEventId}`,
    title, body, origin.kind === "queue" ? LAUNDRY_QUEUE_AVAILABILITY_TTL_MS : LAUNDRY_WATCH_AVAILABILITY_TTL_MS,
    [origin]);
}

function clampQueueAvailabilityExpiry(
  event: LaundryTransitionEvent,
  candidate: PlannedLaundryNotification,
): PlannedLaundryNotification {
  if (candidate.notification.kind !== "laundry-available"
    || !candidate.origins.some((origin) => origin.kind === "queue")) return candidate;
  const expiresAtEpochMs = event.occurredAtEpochMs + LAUNDRY_QUEUE_AVAILABILITY_TTL_MS;
  if (candidate.notification.expiresAtEpochMs === expiresAtEpochMs) return candidate;
  const payload = JSON.parse(candidate.notification.payloadJson) as Record<string, unknown>;
  return {
    ...candidate,
    notification: {
      ...candidate.notification,
      expiresAtEpochMs,
      payloadJson: JSON.stringify({ ...payload, expiresAtEpochMs }),
    },
  };
}

function watchEventNotification(
  event: LaundryTransitionEvent,
  watch: LaundryWatchRecord,
  kind: "laundry-finishing" | "laundry-completed" | "laundry-attention",
): PlannedLaundryNotification {
  const labels = kind === "laundry-finishing"
    ? {
        title: `${applianceLabel(event.appliance)} 종료 ${watch.notifyBeforeMinutes}분 전`,
        body: `${machineLabel(event.machineId)} ${deviceLabel(event.appliance)}가 곧 끝납니다.`,
      }
    : kind === "laundry-completed"
      ? {
          title: `${applianceLabel(event.appliance)} 완료`,
          body: `${machineLabel(event.machineId)} ${deviceLabel(event.appliance)}가 끝났습니다. 세탁물을 꺼내 주세요.`,
        }
      : {
          title: `${applianceLabel(event.appliance)} ${event.currentState === "ERROR" ? "오류" : "일시 정지"}`,
          body: `${machineLabel(event.machineId)} ${deviceLabel(event.appliance)} 상태를 확인해 주세요.`,
        };
  const suffix = kind === "laundry-finishing"
    ? `${watch.notifyBeforeMinutes}`
    : kind === "laundry-completed" ? "terminal" : event.currentState;
  const sourceEventId = `${kind}:${watch.id}:${event.sessionId ?? "none"}:${suffix}`;
  return plannedNotification(event, watch.userId, kind, sourceEventId, labels.title, labels.body,
    kind === "laundry-finishing" ? 2 * 60 * 60_000 : 6 * 60 * 60_000,
    [{ kind: "watch", id: watch.id }]);
}

function plannedNotification(
  event: LaundryTransitionEvent,
  userId: string,
  kind: NotificationRecord["kind"],
  sourceEventId: string,
  title: string,
  body: string,
  ttlMs: number,
  origins: LaundryNotificationOrigin[],
): PlannedLaundryNotification {
  const id = crypto.randomUUID();
  const expiresAtEpochMs = event.occurredAtEpochMs + ttlMs;
  const payload = {
    notificationId: id, kind, title, body, path: "/dashboard.html#laundry",
    machineId: event.machineId, appliance: event.appliance, sessionId: event.sessionId,
    createdAtEpochMs: event.occurredAtEpochMs, expiresAtEpochMs,
  };
  return {
    notification: {
      id, userId, sourceEventId, kind, title, body, path: payload.path,
      payloadJson: JSON.stringify(payload), createdAtEpochMs: event.occurredAtEpochMs,
      dueAtEpochMs: event.occurredAtEpochMs, expiresAtEpochMs, desktopAttempt: 0,
    },
    origins,
  };
}

function becameAvailable(event: LaundryTransitionEvent): boolean {
  return event.currentState === "AVAILABLE" && event.previousState !== null && event.previousState !== "AVAILABLE";
}

function watchIsTerminal(event: LaundryTransitionEvent, watch: LaundryWatchRecord): boolean {
  if (watch.sessionId === null && watch.notifyWhenAvailable && becameAvailable(event)) return true;
  return watch.sessionId !== null && watch.sessionId === event.sessionId
    && (event.currentState === "COMPLETED" || becameAvailable(event));
}

function sessionMatches(watch: LaundryWatchRecord, sessionId: string | null): boolean {
  return watch.sessionId === null || watch.sessionId === sessionId;
}

function applianceLabel(appliance: LaundryAppliance): string {
  return appliance === "washer" ? "세탁" : "건조";
}

function deviceLabel(appliance: LaundryAppliance): string {
  return appliance === "washer" ? "세탁기" : "건조기";
}

function machineLabel(machineId: string): string {
  const suffix = /\d+$/u.exec(machineId)?.[0];
  return suffix ? `${suffix}번` : machineId;
}
