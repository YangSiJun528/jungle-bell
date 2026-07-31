import { createHash } from "node:crypto";

import type {
  LaundryQueueEntry,
  LaundryWatch,
} from "../campus/contracts.js";
import type {
  NotificationIntent,
  NotificationRuleReader,
  NotificationSourceEvent,
} from "./contracts.js";

export class ServerNotificationPlanner {
  constructor(
    private readonly rules: NotificationRuleReader,
  ) {}

  plan(event: NotificationSourceEvent): NotificationIntent[] {
    validateSourceEvent(event);
    switch (event.kind) {
      case "meal-published":
        return this.planMeal(event);
      case "laundry-transition":
        return this.planLaundryTransition(event);
      case "attendance-action-required":
        return this.rules.isAttendancePhaseEnabled(
          event.userId,
          event.phase,
        )
          ? [attendanceIntent(event)]
          : [];
      case "login-required":
        return [loginRequiredIntent(event)];
    }
  }

  private planMeal(
    event: Extract<
      NotificationSourceEvent,
      { readonly kind: "meal-published" }
    >,
  ): NotificationIntent[] {
    const periodLabel = {
      breakfast: "조식",
      lunch: "중식",
      dinner: "석식",
    }[event.meal];
    return this.rules
      .listMealSubscriberUserIds(event.meal)
      .map((userId) => ({
        userId,
        kind: "meal-published",
        sourceEventId: event.sourceEventId,
        dedupeKey: dedupe([
          "v1",
          userId,
          "meal",
          event.serviceDate,
          event.meal,
          event.contentSha,
        ]),
        content: {
          title: `오늘 ${periodLabel}이 올라왔어요`,
          body: preview(event.preview),
          path: "/app#meals",
        },
        metadata: {
          meal: event.meal,
          serviceDate: event.serviceDate,
          contentSha: event.contentSha,
        },
        targetDeviceId: null,
        occurredAtEpochMs: event.occurredAtEpochMs,
        expiresAtEpochMs:
          event.occurredAtEpochMs + 12 * 60 * 60 * 1_000,
      }));
  }

  planLaundryTransition(
    event: Extract<
      NotificationSourceEvent,
      { readonly kind: "laundry-transition" }
    >,
    selection?: {
      readonly watches: readonly LaundryWatch[];
      readonly queueEntry: LaundryQueueEntry | null;
    },
  ): NotificationIntent[] {
    validateSourceEvent(event);
    const watches =
      selection?.watches ??
      this.rules.listActiveWatches({
        machineId: event.machineId,
        appliance: event.appliance,
        sessionId: event.sessionId,
      });
    const intents = watches.flatMap((watch) =>
      watchIntent(event, watch),
    );
    if (becameAvailable(event)) {
      const queueEntry =
        selection?.queueEntry ??
        this.rules.findWaitingQueueHead({
          machineId: event.machineId,
          appliance: event.appliance,
        });
      if (queueEntry !== null) {
        intents.push(
          availableIntent(event, queueEntry.userId, queueEntry.id),
        );
      }
    }

    const unique = new Map<string, NotificationIntent>();
    for (const intent of intents) {
      unique.set(`${intent.userId}:${intent.dedupeKey}`, intent);
    }
    return [...unique.values()];
  }
}

function watchIntent(
  event: Extract<
    NotificationSourceEvent,
    { readonly kind: "laundry-transition" }
  >,
  watch: LaundryWatch,
): NotificationIntent[] {
  if (becameAvailable(event) && watch.notifyWhenAvailable) {
    return [availableIntent(event, watch.userId, watch.id)];
  }
  if (
    becameAvailable(event) &&
    watch.sessionId !== null &&
    sessionMatches(watch, event.sessionId)
  ) {
    return [
      laundryIntent(
        event,
        watch,
        "laundry-completed",
        `${applianceLabel(event.appliance)} 완료`,
        `${machineLabel(event.machineId)} ${deviceLabel(event.appliance)}가 끝났습니다. 세탁물을 꺼내 주세요.`,
      ),
    ];
  }
  if (
    event.currentState === "COMPLETED" &&
    watch.sessionId !== null &&
    sessionMatches(watch, event.sessionId)
  ) {
    return [
      laundryIntent(
        event,
        watch,
        "laundry-completed",
        `${applianceLabel(event.appliance)} 완료`,
        `${machineLabel(event.machineId)} ${deviceLabel(event.appliance)}가 끝났습니다. 세탁물을 꺼내 주세요.`,
      ),
    ];
  }
  if (
    (event.currentState === "ERROR" ||
      event.currentState === "PAUSED") &&
    watch.sessionId !== null &&
    sessionMatches(watch, event.sessionId)
  ) {
    const stateLabel =
      event.currentState === "ERROR" ? "오류" : "일시 정지";
    return [
      laundryIntent(
        event,
        watch,
        "laundry-attention",
        `${applianceLabel(event.appliance)} ${stateLabel}`,
        `${machineLabel(event.machineId)} ${deviceLabel(event.appliance)} 상태를 확인해 주세요.`,
      ),
    ];
  }
  if (
    event.currentState === "BUSY" &&
    event.remainingMinutes !== null &&
    event.remainingMinutes > 0 &&
    event.remainingMinutes <= watch.notifyBeforeMinutes &&
    watch.sessionId !== null &&
    sessionMatches(watch, event.sessionId)
  ) {
    return [
      laundryIntent(
        event,
        watch,
        "laundry-finishing",
        `${applianceLabel(event.appliance)} 종료 ${watch.notifyBeforeMinutes}분 전`,
        `${machineLabel(event.machineId)} ${deviceLabel(event.appliance)}가 곧 끝납니다.`,
      ),
    ];
  }
  return [];
}

function availableIntent(
  event: Extract<
    NotificationSourceEvent,
    { readonly kind: "laundry-transition" }
  >,
  userId: string,
  ruleId: string,
): NotificationIntent {
  return {
    userId,
    kind: "laundry-available",
    sourceEventId: event.sourceEventId,
    dedupeKey: dedupe([
      "v1",
      userId,
      "laundry-available",
      event.machineId,
      event.appliance,
      event.sourceEventId,
    ]),
    content: {
      title: `${deviceLabel(event.appliance)} 사용 가능`,
      body: `${machineLabel(event.machineId)} ${deviceLabel(event.appliance)}를 사용할 수 있습니다.`,
      path: "/app#laundry",
    },
    metadata: {
      machineId: event.machineId,
      appliance: event.appliance,
      ruleId,
    },
    targetDeviceId: null,
    occurredAtEpochMs: event.occurredAtEpochMs,
    expiresAtEpochMs:
      event.occurredAtEpochMs + 6 * 60 * 60 * 1_000,
  };
}

function laundryIntent(
  event: Extract<
    NotificationSourceEvent,
    { readonly kind: "laundry-transition" }
  >,
  watch: LaundryWatch,
  kind:
    | "laundry-finishing"
    | "laundry-completed"
    | "laundry-attention",
  title: string,
  body: string,
): NotificationIntent {
  return {
    userId: watch.userId,
    kind,
    sourceEventId: event.sourceEventId,
    dedupeKey: dedupe([
      "v1",
      watch.userId,
      kind,
      watch.id,
      event.sessionId ?? "none",
      kind === "laundry-finishing"
        ? String(watch.notifyBeforeMinutes)
        : kind === "laundry-completed"
          ? "terminal"
          : event.currentState,
    ]),
    content: { title, body, path: "/app#laundry" },
    metadata: {
      watchId: watch.id,
      machineId: event.machineId,
      appliance: event.appliance,
      sessionId: event.sessionId,
    },
    targetDeviceId: null,
    occurredAtEpochMs: event.occurredAtEpochMs,
    expiresAtEpochMs:
      event.occurredAtEpochMs +
      (kind === "laundry-finishing"
        ? 2 * 60 * 60 * 1_000
        : 6 * 60 * 60 * 1_000),
  };
}

function attendanceIntent(
  event: Extract<
    NotificationSourceEvent,
    { readonly kind: "attendance-action-required" }
  >,
): NotificationIntent {
  const label = event.phase === "morning" ? "오전" : "오후";
  const suffix =
    event.minutesRemaining === null
      ? "출석 상태를 확인해 주세요."
      : `${event.minutesRemaining}분 남았습니다.`;
  return {
    userId: event.userId,
    kind: "attendance-action-required",
    sourceEventId: event.sourceEventId,
    dedupeKey: dedupe([
      "v1",
      event.userId,
      "attendance",
      event.attendanceDate,
      event.phase,
      event.sourceEventId,
    ]),
    content: {
      title: `${label} 출석 확인`,
      body: suffix,
      path: "/app#attendance",
    },
    metadata: {
      attendanceDate: event.attendanceDate,
      phase: event.phase,
      minutesRemaining: event.minutesRemaining,
    },
    targetDeviceId: null,
    occurredAtEpochMs: event.occurredAtEpochMs,
    expiresAtEpochMs:
      event.occurredAtEpochMs +
      Math.max(
        5 * 60 * 1_000,
        Math.min(event.minutesRemaining ?? 60, 60) * 60 * 1_000,
      ),
  };
}

function loginRequiredIntent(
  event: Extract<
    NotificationSourceEvent,
    { readonly kind: "login-required" }
  >,
): NotificationIntent {
  return {
    userId: event.userId,
    kind: "login-required",
    sourceEventId: event.sourceEventId,
    dedupeKey: dedupe([
      "v1",
      event.userId,
      "login-required",
      event.desktopDeviceId ?? "all",
      event.sourceEventId,
    ]),
    content: {
      title: "LMS 로그인이 필요합니다",
      body: "PC에서 Jungle Bell을 열고 LMS에 다시 로그인해 주세요.",
      path: "/app#attendance",
    },
    metadata: {
      reason: event.reason,
      desktopDeviceId: event.desktopDeviceId,
    },
    targetDeviceId: null,
    occurredAtEpochMs: event.occurredAtEpochMs,
    expiresAtEpochMs:
      event.occurredAtEpochMs + 24 * 60 * 60 * 1_000,
  };
}

function becameAvailable(
  event: Extract<
    NotificationSourceEvent,
    { readonly kind: "laundry-transition" }
  >,
): boolean {
  return (
    event.currentState === "AVAILABLE" &&
    event.previousState !== null &&
    event.previousState !== "AVAILABLE"
  );
}

function sessionMatches(
  watch: LaundryWatch,
  sessionId: string | null,
): boolean {
  return watch.sessionId === null || watch.sessionId === sessionId;
}

function preview(value: string): string {
  const normalized = value.trim().split(/\s+/u).join(" · ");
  if (normalized.length === 0) return "메뉴 내용을 확인해 주세요.";
  return normalized.length > 120
    ? `${normalized.slice(0, 119)}…`
    : normalized;
}

function applianceLabel(appliance: "washer" | "dryer"): string {
  return appliance === "washer" ? "세탁" : "건조";
}

function deviceLabel(appliance: "washer" | "dryer"): string {
  return appliance === "washer" ? "세탁기" : "건조기";
}

function machineLabel(machineId: string): string {
  const suffix = /\d+$/u.exec(machineId)?.[0];
  return suffix ? `${suffix}번` : machineId;
}

function dedupe(parts: readonly string[]): string {
  return `jbn_${createHash("sha256")
    .update(JSON.stringify(parts))
    .digest("hex")}`;
}

function validateSourceEvent(event: NotificationSourceEvent): void {
  if (
    event.sourceEventId.length < 1 ||
    event.sourceEventId.length > 512 ||
    !Number.isSafeInteger(event.occurredAtEpochMs) ||
    event.occurredAtEpochMs < 0
  ) {
    throw new TypeError("Notification source event is invalid.");
  }
}
