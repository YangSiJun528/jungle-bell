import { describe, expect, it } from "vitest";
import {
  MEAL_NOTIFICATION_TTL_MS,
  mealPublicationEvent,
  runMealPublicationLifecycle,
} from "../src/services/meal-publication-service";
import type { MealPublicationRecord } from "../../../shared/ports/account-storage";
import { MemoryRenewalStore } from "../../../shared/tests/helpers/memory-renewal-store";

const NOW = Date.parse("2026-08-10T03:00:00.000Z");

function post(overrides: Partial<MealPublicationRecord> = {}): MealPublicationRecord {
  return {
    id: "post-1",
    contentSha: "a".repeat(64),
    title: "2026년 8월 10일 중식",
    text: "현미밥, 된장국",
    publishedAt: "2026-08-10T01:00:00.000Z",
    updatedAt: "2026-08-10T01:00:00.000Z",
    firstSeenAt: "2026-08-10T01:01:00.000Z",
    hasPriorVersion: false,
    ...overrides,
  };
}

describe("meal publication lifecycle", () => {
  it("normalizes a DAILY_MENU post into a stable period/date/content event", () => {
    expect(mealPublicationEvent(post(), NOW)).toEqual({
      sourceEventId: `meal:2026-08-10:lunch:${"a".repeat(64)}`,
      meal: "lunch",
      serviceDate: "2026-08-10",
      contentSha: "a".repeat(64),
      preview: "현미밥, 된장국",
      occurredAtEpochMs: Date.parse("2026-08-10T01:01:00.000Z"),
    });
  });

  it("does not create notification events for breakfast posts", () => {
    expect(mealPublicationEvent(post({ title: "2026년 8월 10일 조식" }), NOW)).toBeNull();
  });

  it("fans a fresh subscribed meal out once and uses an event-relative 12-hour TTL", async () => {
    const store = new MemoryRenewalStore();
    store.mealPreferences.set("user-1", {
      enabled: true, lunch: true, dinner: false,
      updatedAtEpochMs: Date.parse("2026-08-10T00:00:00.000Z"),
    });
    store.mealPosts.set("post-1", post());

    await expect(runMealPublicationLifecycle(store, NOW)).resolves.toEqual({
      processedPosts: 1, notifications: 1,
    });
    const [notification] = [...store.notifications.values()];
    expect(notification?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect(notification).toMatchObject({
      userId: "user-1",
      sourceEventId: `meal:2026-08-10:lunch:${"a".repeat(64)}`,
      kind: "meal-published",
      expiresAtEpochMs: Date.parse("2026-08-10T01:01:00.000Z") + MEAL_NOTIFICATION_TTL_MS,
    });
    await expect(runMealPublicationLifecycle(store, NOW + 1)).resolves.toEqual({
      processedPosts: 0, notifications: 0,
    });
  });

  it("baselines expired history and does not replay it when preferences are enabled later", async () => {
    const store = new MemoryRenewalStore();
    store.mealPreferences.set("user-1", {
      enabled: true, lunch: true, dinner: false,
      updatedAtEpochMs: NOW - 60_000,
    });
    store.mealPosts.set("old-post", post({
      id: "old-post",
      firstSeenAt: new Date(NOW - MEAL_NOTIFICATION_TTL_MS - 1).toISOString(),
    }));

    await expect(runMealPublicationLifecycle(store, NOW)).resolves.toEqual({
      processedPosts: 1, notifications: 0,
    });
    expect(store.notifications.size).toBe(0);
    expect(store.processedMealVersions.has(`old-post:${"a".repeat(64)}`)).toBe(true);
  });

  it("treats a changed content hash as a new event detected now", () => {
    expect(mealPublicationEvent(post({
      contentSha: "b".repeat(64),
      firstSeenAt: "2026-07-01T00:00:00.000Z",
      hasPriorVersion: true,
    }), NOW)?.occurredAtEpochMs).toBe(NOW);
  });
});
