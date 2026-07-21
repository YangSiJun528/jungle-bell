import { afterEach, describe, expect, it, vi } from "vitest";
import type { MealsVersion } from "../src/collector/meals";
import { app } from "../src/workers/api";

const env = {
  DB: {
    prepare: () => ({
      all: async () => ({ results: [] }),
    }),
  } as unknown as D1Database,
  DATA_BUCKET: {} as R2Bucket,
};

afterEach(() => vi.useRealTimers());

function mealsEnv(title: string) {
  const version: MealsVersion = {
    schemaVersion: 2,
    sourceVersionSha: "a".repeat(64),
    observedAt: "2026-07-19T03:00:00.000Z",
    hasNext: false,
    pinnedMenus: [{
      id: "weekly",
      kind: "PINNED_MENU",
      contentSha: "b".repeat(64),
      title,
      text: "",
      pinned: true,
      publishedAt: null,
      updatedAt: "2026-07-19T02:00:00.000Z",
      permalink: null,
      status: "published",
      images: [],
    }],
    dailyMenus: [],
    otherPosts: [],
  };
  const db = {
    prepare: (sql: string) => {
      const statement = {
        bind: (..._values: unknown[]) => statement,
        first: async () => sql.includes("source_state") ? {
          source: "meals-include-pinned",
          last_attempt_at: version.observedAt,
          last_success_at: version.observedAt,
          last_response_sha: version.sourceVersionSha,
          last_raw_key: "raw/meals.json",
          last_normalized_key: "versions/meals.json",
          version_first_seen_at: version.observedAt,
          consecutive_failures: 0,
          last_error: null,
        } : null,
        all: async () => ({ results: [] }),
      };
      return statement;
    },
  } as unknown as D1Database;
  const bucket = {
    get: async (key: string) => key === "versions/meals.json"
      ? { json: async () => version }
      : null,
  } as unknown as R2Bucket;
  return { DB: db, DATA_BUCKET: bucket };
}

describe("API middleware", () => {
  it("validates RFC3339 query parameters with Zod", async () => {
    const valid = await app.request(
      "https://api.test/v1/laundry/at?time=2026-07-18T12%3A34%3A56%2B09%3A00",
      {},
      env,
    );
    expect(valid.status).toBe(308);
    expect(valid.headers.get("Location")).toBe("/v1/laundry/minutes/20260718T0334Z");
    expect(valid.headers.get("Cache-Control")).toContain("immutable");

    const invalid = await app.request("https://api.test/v1/laundry/at?time=2026-07-18", {}, env);
    expect(invalid.status).toBe(400);
    expect(invalid.headers.get("Cache-Control")).toBe("no-store");
    await expect(invalid.json()).resolves.toMatchObject({ error: "INVALID_REQUEST" });
  });

  it("uses Hono ETag handling for dynamic JSON responses", async () => {
    const first = await app.request("https://api.test/v1/status", {}, env);
    expect(first.status).toBe(200);
    expect(first.headers.get("Content-Type")).toContain("application/json");
    expect(first.headers.get("Cache-Control")).toContain("s-maxage=30");
    const responseEtag = first.headers.get("ETag");
    expect(responseEtag).toMatch(/^"[a-f0-9]+"$/);

    const conditional = await app.request(
      "https://api.test/v1/status",
      { headers: { "If-None-Match": responseEtag ?? "" } },
      env,
    );
    expect(conditional.status).toBe(304);
    expect(conditional.headers.get("ETag")).toBe(responseEtag);
    expect(conditional.headers.get("Cache-Control")).toContain("s-maxage=30");
  });

  it("does not expose the previous pinned menu as the upcoming Sunday week", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-19T03:00:00.000Z"));

    const response = await app.request("https://api.test/v1/meals", {}, mealsEnv("7월 2주차 식단표"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        schemaVersion: 2,
        currentWeeklyMenu: {
          targetWeekKey: "2026-07-20",
          status: "AWAITING_UPDATE",
          contentSha: null,
          post: null,
        },
      },
    });
  });
});
