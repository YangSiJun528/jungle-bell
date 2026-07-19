import { describe, expect, it } from "vitest";
import type { CollectionCommit, SourceState } from "../src/collector/types";
import { CloudflareApiStorage } from "../src/workers/cloudflare-storage";

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

function mealCommit(): CollectionCommit {
  const source = "meals-include-pinned" as const;
  return {
    state: { ...state(), source },
    observation: {
      ...commit().observation,
      source,
    },
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
}

describe("CloudflareApiStorage", () => {
  it("applies an archived commit only to the API query tables", async () => {
    const statements: Array<{ sql: string; values: unknown[] }> = [];
    const db = {
      prepare: (sql: string) => ({
        bind: (...values: unknown[]) => {
          const statement = { sql, values };
          statements.push(statement);
          return statement;
        },
      }),
      batch: async () => [],
    } as unknown as D1Database;
    await new CloudflareApiStorage(db, {} as R2Bucket).applyCommit(commit());

    expect(statements).toHaveLength(2);
    expect(statements.some(({ sql }) => sql.includes("minute_observation"))).toBe(true);
    expect(statements.some(({ sql }) => sql.includes("source_state"))).toBe(true);
    expect(statements.some(({ sql }) => sql.includes("source_version"))).toBe(false);
  });

  it("keeps each pinned menu as a KST weekly snapshot", async () => {
    const statements: Array<{ sql: string; values: unknown[] }> = [];
    const db = {
      prepare: (sql: string) => ({
        bind: (...values: unknown[]) => {
          const statement = { sql, values };
          statements.push(statement);
          return statement;
        },
      }),
      batch: async () => [],
    } as unknown as D1Database;

    await new CloudflareApiStorage(db, {} as R2Bucket).applyCommit(mealCommit());

    const weekly = statements.find(({ sql }) => sql.includes("INSERT INTO meal_weekly_menu"));
    expect(weekly?.values[0]).toBe("2026-07-13");
    expect(weekly?.values[1]).toMatch(/^[a-f0-9]{64}$/);
    expect(weekly?.values[2]).toContain('"kind":"PINNED_MENU"');
    expect(weekly?.sql).toContain("excluded.content_sha <> meal_weekly_menu.content_sha");
  });

  it("uses the provider title instead of a Sunday update timestamp", async () => {
    const statements: Array<{ sql: string; values: unknown[] }> = [];
    const db = {
      prepare: (sql: string) => ({
        bind: (...values: unknown[]) => {
          const statement = { sql, values };
          statements.push(statement);
          return statement;
        },
      }),
      batch: async () => [],
    } as unknown as D1Database;
    const weeklyCommit = mealCommit();
    weeklyCommit.mealObservedAt = "2026-07-19T03:00:00.000Z";
    weeklyCommit.mealPosts![0]!.title = "7월 3주차 식단표";
    weeklyCommit.mealPosts![0]!.updatedAt = "2026-07-19T02:00:00.000Z";

    await new CloudflareApiStorage(db, {} as R2Bucket).applyCommit(weeklyCommit);

    const weekly = statements.find(({ sql }) => sql.includes("INSERT INTO meal_weekly_menu"));
    expect(weekly?.values[0]).toBe("2026-07-20");
  });
});
