import type {
  MealPeriod, MealPublicationRecord, NotificationRecord,
} from "@jungle-bell/backend-common/ports/account-storage";

export interface MealPublicationStore {
  listUnprocessedMealPosts(limit: number): Promise<MealPublicationRecord[]>;
  listMealSubscriberUserIds(meal: MealPeriod, occurredAtEpochMs: number): Promise<string[]>;
  insertNotification(notification: NotificationRecord): Promise<boolean>;
  markMealPostProcessed(postId: string, contentSha: string, nowEpochMs: number): Promise<boolean>;
}

export const MEAL_NOTIFICATION_TTL_MS = 12 * 60 * 60_000;
const MAX_FUTURE_SKEW_MS = 5 * 60_000;
const KST_OFFSET_MS = 9 * 60 * 60_000;

export interface MealPublicationEvent {
  sourceEventId: string;
  meal: MealPeriod;
  serviceDate: string;
  contentSha: string;
  preview: string;
  occurredAtEpochMs: number;
}

/** Publishes meal notifications from newly collected posts. */
export async function runMealPublicationLifecycle(
  store: MealPublicationStore,
  nowEpochMs: number,
): Promise<{ processedPosts: number; notifications: number }> {
  let processedPosts = 0;
  let notifications = 0;
  for (const post of await store.listUnprocessedMealPosts(100)) {
    const event = mealPublicationEvent(post, nowEpochMs);
    if (event && event.occurredAtEpochMs <= nowEpochMs + MAX_FUTURE_SKEW_MS
      && event.occurredAtEpochMs + MEAL_NOTIFICATION_TTL_MS > nowEpochMs) {
      const userIds = [...new Set(await store.listMealSubscriberUserIds(event.meal, event.occurredAtEpochMs))];
      for (const userId of userIds) {
        if (await store.insertNotification(mealNotification(userId, event, nowEpochMs))) {
          notifications += 1;
        }
      }
    }
    if (await store.markMealPostProcessed(post.id, post.contentSha, nowEpochMs)) processedPosts += 1;
  }
  return { processedPosts, notifications };
}

export function mealPublicationEvent(
  post: MealPublicationRecord,
  detectedAtEpochMs: number,
): MealPublicationEvent | null {
  const meal = mealPeriod(post.title);
  if (!meal) return null;
  const occurredAtEpochMs = post.hasPriorVersion ? detectedAtEpochMs : Date.parse(post.firstSeenAt);
  if (!Number.isSafeInteger(occurredAtEpochMs)) return null;
  const serviceDate = mealServiceDate(post);
  return {
    sourceEventId: `meal:${serviceDate}:${meal}:${post.contentSha}`,
    meal,
    serviceDate,
    contentSha: post.contentSha,
    preview: preview(post.text || post.title || "메뉴 내용을 확인해 주세요."),
    occurredAtEpochMs,
  };
}

function mealNotification(
  userId: string,
  event: MealPublicationEvent,
  nowEpochMs: number,
): NotificationRecord {
  const label = { breakfast: "조식", lunch: "중식", dinner: "석식" }[event.meal];
  const title = `오늘 ${label}이 올라왔어요`;
  const id = crypto.randomUUID();
  const path = "/dashboard.html#meals";
  return {
    id,
    userId,
    sourceEventId: event.sourceEventId,
    kind: "meal-published",
    title,
    body: event.preview,
    path,
    payloadJson: JSON.stringify({
      notificationId: id,
      kind: "meal-published",
      title,
      body: event.preview,
      path,
      createdAtEpochMs: nowEpochMs,
      expiresAtEpochMs: event.occurredAtEpochMs + MEAL_NOTIFICATION_TTL_MS,
      meal: event.meal,
      serviceDate: event.serviceDate,
      contentSha: event.contentSha,
    }),
    createdAtEpochMs: nowEpochMs,
    dueAtEpochMs: nowEpochMs,
    expiresAtEpochMs: event.occurredAtEpochMs + MEAL_NOTIFICATION_TTL_MS,
    desktopAttempt: 0,
  };
}

function mealPeriod(title: string | null): MealPeriod | null {
  const value = title ?? "";
  if (/(조식|아침)/u.test(value)) return "breakfast";
  if (/(중식|점심)/u.test(value)) return "lunch";
  if (/(석식|저녁)/u.test(value)) return "dinner";
  return null;
}

function mealServiceDate(post: MealPublicationRecord): string {
  const match = /(?:(\d{4})년\s*)?(\d{1,2})월\s*(\d{1,2})일/u.exec(post.title ?? "")
    ?? /(?:(\d{4})[./-])?(\d{1,2})[./-](\d{1,2})/u.exec(post.title ?? "");
  const reference = post.publishedAt ?? post.updatedAt ?? post.firstSeenAt;
  const referenceEpoch = Date.parse(reference);
  const fallback = new Date((Number.isFinite(referenceEpoch) ? referenceEpoch : 0) + KST_OFFSET_MS);
  if (match?.[2] && match[3]) {
    const year = match[1] ? Number(match[1]) : fallback.getUTCFullYear();
    const month = Number(match[2]);
    const day = Number(match[3]);
    const candidate = new Date(Date.UTC(year, month - 1, day));
    if (candidate.getUTCFullYear() === year && candidate.getUTCMonth() === month - 1
      && candidate.getUTCDate() === day) return candidate.toISOString().slice(0, 10);
  }
  return fallback.toISOString().slice(0, 10);
}

function preview(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length <= 160 ? normalized : `${normalized.slice(0, 157)}...`;
}
