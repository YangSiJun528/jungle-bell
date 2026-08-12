import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import type { CollectionCommit, SourceState } from "../../../shared/collection/types";
import { buildD1CommitQueries } from "../src/storage/d1-commit-queries";

function state(): SourceState {
  return {
    source: "laundry",
    lastAttemptAt: "2026-07-18T00:00:01.000Z",
    lastSuccessAt: "2026-07-18T00:00:01.000Z",
    lastResponseSha: "a".repeat(64),
    lastRawKey: "raw/laundry/2026/07/18/snapshot.json",
    lastNormalizedKey: "versions/laundry/version.json",
    versionFirstSeenAt: "2026-07-18T00:00:01.000Z",
    consecutiveFailures: 0,
    lastError: null,
  };
}

function commit(): CollectionCommit {
  return {
    state: state(),
    observation: {
      source: "laundry",
      minuteEpoch: Date.parse("2026-07-18T00:00:00.000Z") / 60_000,
      scheduledAt: "2026-07-18T00:00:00.000Z",
      collectedAt: "2026-07-18T00:00:01.000Z",
      status: "SUCCESS",
      versionSha: "a".repeat(64),
      rawKey: "raw/laundry/2026/07/18/snapshot.json",
      normalizedKey: "versions/laundry/version.json",
      versionFirstSeenAt: "2026-07-18T00:00:01.000Z",
      changed: true,
      durationMs: 1_000,
      httpStatus: 200,
      error: null,
    },
  };
}

describe("buildD1CommitQueries", () => {
  it("builds idempotent observation, state, and laundry event queries", async () => {
    const value = commit();
    value.laundryEvents = [{
      id: "event-id",
      machineId: "tower6",
      appliance: "washer",
      sessionId: "session-id",
      type: "ETA_EXTENDED",
      previousObservedAt: "2026-07-17T23:59:01.000Z",
      observedAt: "2026-07-18T00:00:01.000Z",
      etaDeltaMinutes: 4,
      previousState: "RUNNING",
      currentState: "RUNNING",
      detail: { reason: "observed" },
    }];

    const queries = await buildD1CommitQueries(value);

    expect(queries).toHaveLength(3);
    expect(queries.every(({ sql }) => sql.includes("ON CONFLICT"))).toBe(true);
    expect(queries[0]?.params.slice(0, 2)).toEqual(["laundry", value.observation.minuteEpoch]);
    expect(JSON.parse(String(queries[2]?.params[0]))).toMatchObject([{ id: "event-id" }]);
    expect(queries.map(({ sql }) => sql).join("\n")).not.toContain("event-id");
  });

  it("preserves weekly and daily meal indexing in the direct D1 batch", async () => {
    const source = "meals-include-pinned" as const;
    const value: CollectionCommit = {
      state: { ...state(), source },
      observation: { ...commit().observation, source },
      mealObservedAt: "2026-07-13T01:00:00.000Z",
      mealPosts: [{
        id: "weekly",
        kind: "PINNED_MENU",
        contentSha: "b".repeat(64),
        title: "7월 2주차 식단표",
        text: "",
        pinned: true,
        publishedAt: "2026-03-09T01:00:00.000Z",
        updatedAt: "2026-07-13T00:00:00.000Z",
        permalink: null,
        status: "published",
        images: [],
      }],
    };

    const queries = await buildD1CommitQueries(value);

    const weekly = queries.find(({ sql }) => sql.includes("INSERT INTO meal_weekly_menu"));
    const weeklyPayload = JSON.parse(String(weekly?.params[0])) as Array<Record<string, string>>;
    expect(weeklyPayload[0]?.weekKey).toBe("2026-07-13");
    expect(weeklyPayload[0]?.contentSha).toMatch(/^[a-f0-9]{64}$/);
    expect(weeklyPayload[0]?.postJson).toContain('"kind":"PINNED_MENU"');
    expect(queries.some(({ sql }) => sql.includes("INSERT INTO meal_post"))).toBe(true);
    expect(queries.some(({ sql }) => sql.includes("DELETE FROM meal_image"))).toBe(true);
  });

  it("atomically persists 30 multi-image posts below the D1 Free 50-query limit", async () => {
    const source = "meals-default" as const;
    const value: CollectionCommit = {
      state: { ...state(), source },
      observation: { ...commit().observation, source },
      mealObservedAt: "2026-07-13T01:00:00.000Z",
      mealPosts: Array.from({ length: 30 }, (_, postIndex) => ({
        id: `post-${postIndex}`,
        kind: "DAILY_MENU" as const,
        contentSha: "0".repeat(64),
        title: `식단 ${postIndex}`,
        text: `메뉴 ${postIndex}`,
        pinned: false,
        publishedAt: "2026-07-13T00:00:00.000Z",
        updatedAt: "2026-07-13T00:30:00.000Z",
        permalink: null,
        status: "published",
        images: Array.from({ length: 3 }, (_, imageIndex) => ({
          postId: `post-${postIndex}`,
          mediaId: `media-${postIndex}-${imageIndex}`,
          sourceUrl: `https://example.com/${postIndex}/${imageIndex}.jpg`,
          declaredContentType: "image/jpeg",
          filename: `${imageIndex}.jpg`,
          width: 1200,
          height: 800,
          sha: String(postIndex * 3 + imageIndex).padStart(64, "0"),
          objectKey: `meals/${postIndex}/${imageIndex}.jpg`,
          contentType: "image/jpeg",
          extension: "jpg",
          byteLength: 1_024,
        })),
      })),
    };
    const queries = await buildD1CommitQueries(value);
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(readFileSync(new URL("../../../database/schema.sql", import.meta.url), "utf8"));
      database.exec("BEGIN IMMEDIATE");
      for (const query of queries) database.prepare(query.sql).run(...query.params);
      database.exec("COMMIT");

      expect(queries.length).toBeLessThanOrEqual(50);
      expect(queries.every((query) => query.params.length <= 100)).toBe(true);
      expect(database.prepare("SELECT count(*) AS count FROM meal_post").get()).toEqual({ count: 30 });
      expect(database.prepare("SELECT count(*) AS count FROM meal_image").get()).toEqual({ count: 90 });
    } finally {
      database.close();
    }
  });
});
