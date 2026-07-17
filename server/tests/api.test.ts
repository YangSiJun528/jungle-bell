import { describe, expect, it } from "vitest";
import app from "../src/workers/api";

const env = {
  DB: {
    prepare: () => ({
      all: async () => ({ results: [] }),
    }),
  } as unknown as D1Database,
  DATA_BUCKET: {} as R2Bucket,
};

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
});
