import { describe, expect, it } from "vitest";
import type { CollectionCommit, SourceState } from "../src/collector/types";
import { buildD1CommitQueries } from "../src/storage/d1-commit";

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
    expect(queries[2]?.params[0]).toBe("event-id");
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
    expect(weekly?.params[0]).toBe("2026-07-13");
    expect(weekly?.params[1]).toMatch(/^[a-f0-9]{64}$/);
    expect(weekly?.params[2]).toContain('"kind":"PINNED_MENU"');
    expect(queries.some(({ sql }) => sql.includes("INSERT INTO meal_post"))).toBe(true);
    expect(queries.some(({ sql }) => sql.includes("DELETE FROM meal_image"))).toBe(true);
  });
});
