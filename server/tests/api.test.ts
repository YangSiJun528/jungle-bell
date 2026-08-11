import { afterEach, describe, expect, it, vi } from "vitest";
import type { MealsVersion } from "../src/collector/meals";
import apiWorker, { app } from "../src/workers/api";

const env = {
  DB: {
    prepare: () => {
      const statement = {
        bind: (..._values: unknown[]) => statement,
        first: async () => null,
        all: async () => ({ results: [] }),
        run: async () => ({ success: true, results: [{ ok: 1 }], meta: { changes: 0 } }),
      };
      return statement;
    },
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
  it("exports an HTTP-only Worker without a scheduled handler", () => {
    expect(apiWorker.fetch).toBeTypeOf("function");
    expect(apiWorker).not.toHaveProperty("scheduled");
  });

  it("routes the internal D1 gateway without public CORS or caching", async () => {
    const response = await app.request("https://api.test/internal/jobs/d1", {
      method: "POST",
      headers: { authorization: `Bearer ${"s".repeat(64)}`, "content-type": "application/json" },
      body: JSON.stringify({ sql: "SELECT 1 AS ok", params: [] }),
    }, { ...env, JOBS_D1_GATEWAY_SECRET: "s".repeat(64) });

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("redirects clean blog entry URLs to the exact static asset path", async () => {
    for (const path of ["/blog", "/blog/"]) {
      const response = await app.request(`https://api.test${path}`, {}, env);
      expect(response.status).toBe(308);
      expect(response.headers.get("Location")).toBe("/blog/index.html");
    }
  });

  it("validates RFC3339 query parameters with Zod", async () => {
    const valid = await app.request(
      "https://api.test/api/public/laundry/at?time=2026-07-18T12%3A34%3A56%2B09%3A00",
      {},
      env,
    );
    expect(valid.status).toBe(308);
    expect(valid.headers.get("Location")).toBe("/api/public/laundry/minutes/20260718T0334Z");
    expect(valid.headers.get("Cache-Control")).toContain("immutable");

    const invalid = await app.request("https://api.test/api/public/laundry/at?time=2026-07-18", {}, env);
    expect(invalid.status).toBe(400);
    expect(invalid.headers.get("Cache-Control")).toBe("no-store");
    await expect(invalid.json()).resolves.toMatchObject({ error: "INVALID_REQUEST" });
  });

  it("accepts only timestamp-plus-id meal history cursors", async () => {
    const cursor = "2026-08-10T02:07:38.000Z~meal-30";
    const valid = await app.request(
      `https://api.test/api/public/meals/history?before=${encodeURIComponent(cursor)}&limit=30`,
      {},
      env,
    );
    expect(valid.status).toBe(200);
    await expect(valid.json()).resolves.toEqual({ posts: [], nextBefore: null });

    const timestampOnly = await app.request(
      "https://api.test/api/public/meals/history?before=2026-08-10T02%3A07%3A38.000Z&limit=30",
      {},
      env,
    );
    expect(timestampOnly.status).toBe(400);
    await expect(timestampOnly.json()).resolves.toMatchObject({ error: "INVALID_REQUEST" });

    const timestamp = "2026-08-09T02:07:38.000Z";
    const row = {
      id: "meal-1",
      kind: "DAILY_MENU",
      content_sha: "a".repeat(64),
      title: "8월 9일 중식",
      text: "밥",
      pinned: 0,
      published_at: timestamp,
      updated_at: null,
      permalink: null,
      status: "published",
      first_seen_at: timestamp,
      last_seen_at: timestamp,
    };
    const historyDb = {
      prepare: (sql: string) => {
        const statement = {
          bind: (..._values: unknown[]) => statement,
          all: async () => ({ results: sql.includes("SELECT * FROM meal_post") ? [row] : [] }),
        };
        return statement;
      },
    } as unknown as D1Database;
    const page = await app.request(
      "https://api.test/api/public/meals/history?limit=1",
      {},
      { ...env, DB: historyDb },
    );
    expect(page.status).toBe(200);
    await expect(page.json()).resolves.toMatchObject({
      posts: [{ id: "meal-1" }],
      nextBefore: `${timestamp}~meal-1`,
    });
  });

  it("does not expose the removed v1 compatibility routes", async () => {
    const response = await app.request("https://api.test/v1/status", {}, env);
    expect(response.status).toBe(404);
  });

  it("uses the canonical public laundry root without a latest alias", async () => {
    expect((await app.request("https://api.test/api/public/laundry", {}, env)).status).toBe(503);
    expect((await app.request("https://api.test/api/public/laundry/latest", {}, env)).status).toBe(404);
  });

  it("uses Hono ETag handling for dynamic JSON responses", async () => {
    const first = await app.request("https://api.test/api/public/status", {}, env);
    expect(first.status).toBe(200);
    expect(first.headers.get("Content-Type")).toContain("application/json");
    expect(first.headers.get("Cache-Control")).toContain("s-maxage=30");
    const responseEtag = first.headers.get("ETag");
    expect(responseEtag).toMatch(/^"[a-f0-9]+"$/);

    const conditional = await app.request(
      "https://api.test/api/public/status",
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

    const response = await app.request("https://api.test/api/public/meals", {}, mealsEnv("7월 2주차 식단표"));

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

  it("serves only allowlisted raster assets with defensive headers", async () => {
    const sha = "a".repeat(64);
    const bucket = {
      get: async (key: string) => key.endsWith(`${sha}.jpg`) ? {
        body: new Uint8Array([0xff, 0xd8, 0xff]),
        writeHttpMetadata: (headers: Headers) => headers.set("Content-Type", "image/svg+xml"),
      } : null,
    } as unknown as R2Bucket;
    const raster = await app.request(`https://api.test/api/public/assets/${sha}.jpg`, {}, {
      ...env, DATA_BUCKET: bucket,
    });
    expect(raster.status).toBe(200);
    expect(raster.headers.get("content-type")).toBe("image/jpeg");
    expect(raster.headers.get("x-content-type-options")).toBe("nosniff");
    expect(raster.headers.get("content-security-policy")).toContain("sandbox");
    expect(raster.headers.get("cross-origin-resource-policy")).toBe("cross-origin");

    const svg = await app.request(`https://api.test/api/public/assets/${sha}.svg`, {}, {
      ...env, DATA_BUCKET: bucket,
    });
    expect(svg.status).toBe(404);
  });
});
