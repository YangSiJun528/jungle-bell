import { describe, expect, it, vi } from "vitest";

import {
  campusDataSourceFromEnvironment,
  CampusSourceError,
  HttpCampusDataSource,
} from "./source.js";
import { laundryResponseSchema } from "./contracts.js";
import { laundryFixture } from "./test-fixtures.js";

describe("HttpCampusDataSource", () => {
  it("uses the production v1 paths, ETag and validated JSON", async () => {
    const fixture = {
      ...laundryFixture(),
      events: [productionDecimalEtaEvent(-0.9)],
    };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(fixture, {
        headers: { ETag: '"laundry-v1"' },
      }),
    );
    const source = new HttpCampusDataSource({
      baseUrl: "https://campus.example/base",
      fetch: fetchMock,
      now: () => 1_000,
    });

    const result = await source.fetch("laundry", {
      ifNoneMatch: '"old"',
    });

    expect(result).toMatchObject({
      status: "modified",
      etag: '"laundry-v1"',
      checkedAtEpochMs: 1_000,
      data: {
        events: [{ etaDeltaMinutes: -0.9 }],
      },
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe(
      "https://campus.example/v1/laundry/latest",
    );
    expect(init?.headers).toMatchObject({
      Accept: "application/json",
      "If-None-Match": '"old"',
    });
  });

  it.each([
    ["NaN", Number.NaN],
    ["positive infinity", Number.POSITIVE_INFINITY],
    ["negative infinity", Number.NEGATIVE_INFINITY],
    ["non-number", "-0.9"],
    ["above the safe numeric boundary", Number.MAX_SAFE_INTEGER + 1],
    ["below the safe numeric boundary", Number.MIN_SAFE_INTEGER - 1],
  ])("rejects an invalid etaDeltaMinutes value: %s", (_label, value) => {
    expect(
      laundryResponseSchema.safeParse({
        ...laundryFixture(),
        events: [productionDecimalEtaEvent(value)],
      }).success,
    ).toBe(false);
  });

  it("returns a conditional not-modified result without parsing a body", async () => {
    const source = new HttpCampusDataSource({
      baseUrl: "https://campus.example",
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(null, {
          status: 304,
          headers: { ETag: '"same"' },
        }),
      ),
      now: () => 2_000,
    });

    await expect(
      source.fetch("meals", { ifNoneMatch: '"same"' }),
    ).resolves.toEqual({
      status: "not-modified",
      etag: '"same"',
      checkedAtEpochMs: 2_000,
    });
  });

  it("validates meal history query and response", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({ posts: [], nextBefore: null }),
    );
    const source = new HttpCampusDataSource({
      baseUrl: "https://campus.example",
      fetch: fetchMock,
    });

    await expect(
      source.fetchMealHistory({ before: "cursor", limit: 20 }),
    ).resolves.toEqual({ posts: [], nextBefore: null });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://campus.example/v1/meals/history?before=cursor&limit=20",
    );
    await expect(
      source.fetchMealHistory({ limit: 101 }),
    ).rejects.toThrow("between 1 and 100");
  });

  it("rejects oversized and schema-invalid responses", async () => {
    const oversized = new HttpCampusDataSource({
      baseUrl: "https://campus.example",
      responseLimitBytes: 10,
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify(laundryFixture()), {
          headers: { "content-type": "application/json" },
        }),
      ),
    });
    await expect(oversized.fetch("laundry")).rejects.toMatchObject({
      code: "RESPONSE_TOO_LARGE",
    } satisfies Partial<CampusSourceError>);

    const invalid = new HttpCampusDataSource({
      baseUrl: "https://campus.example",
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({ schemaVersion: 999 }),
      ),
    });
    await expect(invalid.fetch("laundry")).rejects.toMatchObject({
      code: "INVALID_SCHEMA",
    } satisfies Partial<CampusSourceError>);
  });

  it("keeps the timeout active through body streaming and recovers for the next collection", async () => {
    let cancelled = false;
    const stalledBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{"));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(stalledBody, {
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(Response.json(laundryFixture()));
    const source = new HttpCampusDataSource({
      baseUrl: "https://campus.example",
      fetch: fetchMock,
      timeoutMs: 5,
    });

    await expect(source.fetch("laundry")).rejects.toMatchObject({
      code: "TIMEOUT",
    } satisfies Partial<CampusSourceError>);
    expect(cancelled).toBe(true);
    await expect(source.fetch("laundry")).resolves.toMatchObject({
      status: "modified",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("requires HTTPS for the production campus source while allowing local development HTTP", () => {
    expect(() =>
      campusDataSourceFromEnvironment({
        NODE_ENV: "production",
        JB_CAMPUS_DATA_API_URL: "http://campus.example",
      }),
    ).toThrow("must use HTTPS in production");
    expect(() =>
      campusDataSourceFromEnvironment({
        NODE_ENV: "development",
        JB_CAMPUS_DATA_API_URL: "http://127.0.0.1:9999",
      }),
    ).not.toThrow();
  });
});

function productionDecimalEtaEvent(etaDeltaMinutes: unknown) {
  return {
    id: "tower-1:dryer:session-1:2026-08-03T08:54:08.136Z:COUNTDOWN_NORMAL",
    machineId: "tower-1",
    appliance: "dryer",
    sessionId: "session-1",
    type: "COUNTDOWN_NORMAL",
    previousObservedAt: "2026-08-03T08:49:01.351Z",
    observedAt: "2026-08-03T08:54:08.136Z",
    etaDeltaMinutes,
    previousState: "RUNNING",
    currentState: "RUNNING",
    detail: {
      elapsedMinutes: 5.113083333333333,
      previousRemainingMinutes: 55,
      currentRemainingMinutes: 49,
    },
  };
}
