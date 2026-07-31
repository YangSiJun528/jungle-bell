import { createHash } from "node:crypto";

import type {
  LaundryAppliance,
  LaundryResponse,
  MealPost,
  MealsResponse,
} from "./contracts.js";
import type {
  LaundryState,
  MealPeriod,
  NotificationSourceEvent,
} from "../notifications/contracts.js";

const KST_OFFSET_MS = 9 * 60 * 60 * 1_000;

export interface CampusEventSink {
  record(event: NotificationSourceEvent): unknown;
}

export function detectMealPublishedEvents(
  previous: MealsResponse | null,
  current: MealsResponse,
  nowEpochMs: number,
): NotificationSourceEvent[] {
  if (previous === null) return [];
  const previousVersions = new Set(
    previous.data.dailyMenus.map(
      (post) => `${post.id}:${post.contentSha}`,
    ),
  );
  const events: NotificationSourceEvent[] = [];
  for (const post of current.data.dailyMenus) {
    if (previousVersions.has(`${post.id}:${post.contentSha}`)) continue;
    const meal = mealPeriod(post);
    if (meal === null) continue;
    const serviceDate = mealServiceDate(post, current.asOf);
    events.push({
      kind: "meal-published",
      sourceEventId: `meal:${serviceDate}:${meal}:${post.contentSha}`,
      meal,
      serviceDate,
      contentSha: post.contentSha,
      preview: post.text || post.title || "메뉴 내용을 확인해 주세요.",
      occurredAtEpochMs: nowEpochMs,
    });
  }
  return events;
}

export function detectLaundryTransitionEvents(
  previous: LaundryResponse | null,
  current: LaundryResponse,
  nowEpochMs: number,
): NotificationSourceEvent[] {
  if (previous === null) return [];
  const previousByKey = applianceMap(previous);
  const events: NotificationSourceEvent[] = [];
  for (const [key, appliance] of applianceMap(current)) {
    const before = previousByKey.get(key) ?? null;
    const previousState = before ? notificationState(before) : null;
    const currentState = notificationState(appliance);
    const changed =
      previousState !== currentState ||
      before?.sessionId !== appliance.sessionId ||
      before?.remainingMinutes !== appliance.remainingMinutes;
    if (!changed) continue;
    events.push({
      kind: "laundry-transition",
      sourceEventId: laundrySourceEventId(
        appliance,
        previousState,
        currentState,
      ),
      machineId: appliance.machineId,
      appliance: appliance.appliance,
      sessionId: appliance.sessionId,
      previousState,
      currentState,
      remainingMinutes:
        appliance.projection.remainingMinutes ??
        appliance.remainingMinutes,
      occurredAtEpochMs: nowEpochMs,
    });
  }
  return events;
}

function applianceMap(
  response: LaundryResponse,
): Map<string, LaundryAppliance> {
  const result = new Map<string, LaundryAppliance>();
  for (const machine of response.machines) {
    if (machine.washer) {
      result.set(`${machine.id}:washer`, machine.washer);
    }
    if (machine.dryer) {
      result.set(`${machine.id}:dryer`, machine.dryer);
    }
  }
  return result;
}

function notificationState(
  appliance: LaundryAppliance,
): LaundryState {
  switch (appliance.operationalStatus) {
    case "RUNNING":
    case "SCHEDULED":
      return "BUSY";
    case "PAUSED":
      return "PAUSED";
    case "ERROR":
      return "ERROR";
    case "COMPLETED":
      return "COMPLETED";
    case "IDLE":
      return "AVAILABLE";
    case "UNKNOWN":
      return appliance.projection.status === "IDLE"
        ? "AVAILABLE"
        : "UNKNOWN";
  }
}

function laundrySourceEventId(
  appliance: LaundryAppliance,
  previousState: LaundryState | null,
  currentState: LaundryState,
): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        appliance.machineId,
        appliance.appliance,
        appliance.sessionId,
        previousState,
        currentState,
        appliance.remainingMinutes,
        appliance.observedAt,
      ]),
    )
    .digest("hex");
  return `laundry:${digest}`;
}

function mealPeriod(post: MealPost): MealPeriod | null {
  const title = post.title ?? "";
  if (/(조식|아침)/u.test(title)) return "breakfast";
  if (/(중식|점심)/u.test(title)) return "lunch";
  if (/(석식|저녁)/u.test(title)) return "dinner";
  return null;
}

function mealServiceDate(post: MealPost, fallback: string): string {
  const titleDate =
    /(?:(\d{4})년\s*)?(\d{1,2})월\s*(\d{1,2})일/u.exec(
      post.title ?? "",
    ) ??
    /(?:(\d{4})[./-])?(\d{1,2})[./-](\d{1,2})/u.exec(
      post.title ?? "",
    );
  if (titleDate?.[2] && titleDate[3]) {
    const reference = post.publishedAt ?? post.updatedAt ?? fallback;
    const fallbackKst = new Date(Date.parse(reference) + KST_OFFSET_MS);
    const year = titleDate[1]
      ? Number(titleDate[1])
      : fallbackKst.getUTCFullYear();
    const month = Number(titleDate[2]);
    const day = Number(titleDate[3]);
    const candidate = new Date(Date.UTC(year, month - 1, day));
    if (
      candidate.getUTCFullYear() === year &&
      candidate.getUTCMonth() === month - 1 &&
      candidate.getUTCDate() === day
    ) {
      return candidate.toISOString().slice(0, 10);
    }
  }
  const timestamp = post.publishedAt ?? post.updatedAt ?? fallback;
  return new Date(Date.parse(timestamp) + KST_OFFSET_MS)
    .toISOString()
    .slice(0, 10);
}
