import { describe, expect, it, vi } from "vitest";
import type { CollectionCommit } from "../src/collector/types";
import {
  CloudflareRestStorage,
  type CloudflareRestStorageOptions,
} from "../src/node/cloudflare-rest-storage";
import { D1GatewayDatabase } from "../src/node/d1-gateway-database";

const secret = "s".repeat(64);
const options: CloudflareRestStorageOptions = {
  r2GatewayUrl: "https://api.test/internal/jobs/r2",
  sharedSecret: secret,
  r2RequestRetries: 0,
};

function gateway(fetchMock: typeof fetch): D1GatewayDatabase {
  return new D1GatewayDatabase({
    url: "https://api.test/internal/jobs/d1",
    sharedSecret: secret,
    requestRetries: 0,
  }, { fetch: fetchMock });
}

const commit: CollectionCommit = {
  observation: {
    source: "laundry",
    minuteEpoch: 29_740_320,
    scheduledAt: "2026-07-20T00:00:00.000Z",
    collectedAt: "2026-07-20T00:00:01.000Z",
    status: "SUCCESS",
    versionSha: "a".repeat(64),
    rawKey: "raw/laundry.json",
    normalizedKey: "versions/laundry.json",
    versionFirstSeenAt: "2026-07-20T00:00:01.000Z",
    changed: true,
    durationMs: 100,
    httpStatus: 200,
    error: null,
  },
  state: {
    source: "laundry",
    lastAttemptAt: "2026-07-20T00:00:00.100Z",
    lastSuccessAt: "2026-07-20T00:00:01.000Z",
    lastResponseSha: "a".repeat(64),
    lastRawKey: "raw/laundry.json",
    lastNormalizedKey: "versions/laundry.json",
    versionFirstSeenAt: "2026-07-20T00:00:01.000Z",
    consecutiveFailures: 0,
    lastError: null,
  },
};

function d1Success() {
  return vi.fn(async (_url: string | URL | Request, request?: RequestInit) => {
    const body = JSON.parse(String(request?.body)) as { batch?: unknown[] };
    const count = body.batch?.length ?? 1;
    return new Response(JSON.stringify({
      results: Array.from({ length: count }, () => ({ success: true, results: [] })),
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  });
}

describe("CloudflareRestStorage", () => {
  it("reads source state through the authenticated App Worker D1 gateway", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _request?: RequestInit) =>
      new Response(JSON.stringify({
        results: [{
          success: true,
          results: [{
            source: "laundry",
            last_attempt_at: "2026-07-20T00:00:00.100Z",
            last_success_at: "2026-07-20T00:00:01.000Z",
            last_response_sha: "a".repeat(64),
            last_raw_key: "raw/laundry.json",
            last_normalized_key: "versions/laundry.json",
            version_first_seen_at: "2026-07-20T00:00:01.000Z",
            consecutive_failures: 0,
            last_error: null,
          }],
        }],
      }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    const storage = new CloudflareRestStorage(options, {
      d1: gateway(fetchMock),
      fetch: vi.fn(async () => new Response(null, { status: 204 })),
    });

    const state = await storage.readState("laundry");

    expect(state?.lastResponseSha).toBe("a".repeat(64));
    const [url, request] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://api.test/internal/jobs/d1");
    expect(request?.headers).toMatchObject({ Authorization: `Bearer ${secret}` });
    expect(JSON.parse(String(request?.body))).toMatchObject({ params: ["laundry"] });
  });

  it("uses authenticated raw GET, HEAD, and PUT requests against the R2 gateway", async () => {
    const requests: Array<{ url: URL; request: RequestInit | undefined }> = [];
    const r2Fetch = vi.fn(async (input: string | URL | Request, request?: RequestInit) => {
      const url = new URL(String(input));
      requests.push({ url, request });
      if (request?.method === "GET") return Response.json({ value: 1 });
      if (request?.method === "HEAD") return new Response(null, { status: 200 });
      return new Response(null, { status: 204 });
    });
    const storage = new CloudflareRestStorage(options, { d1: gateway(d1Success()), fetch: r2Fetch });

    await expect(storage.readJson("latest/laundry.json")).resolves.toEqual({ value: 1 });
    await expect(storage.objectExists("latest/laundry.json")).resolves.toBe(true);
    await storage.writeJson("latest/laundry.json", { value: 2 });

    expect(requests.map(({ request }) => request?.method)).toEqual(["GET", "HEAD", "PUT"]);
    expect(requests.map(({ url }) => url.searchParams.get("key"))).toEqual([
      "latest/laundry.json", "latest/laundry.json", "latest/laundry.json",
    ]);
    expect(requests.every(({ request }) =>
      (request?.headers as Record<string, string>).Authorization === `Bearer ${secret}`)).toBe(true);
    expect(requests[2]?.request?.body).toBe('{"value":2}');
    expect(requests[2]?.request?.headers).toMatchObject({
      "Content-Length": String(new TextEncoder().encode('{"value":2}').byteLength),
      "Content-Type": "application/json; charset=utf-8",
    });
  });

  it("treats gateway 404 as a missing object", async () => {
    const r2Fetch = vi.fn(async () => new Response(null, { status: 404 }));
    const storage = new CloudflareRestStorage(options, { d1: gateway(d1Success()), fetch: r2Fetch });

    await expect(storage.readJson("latest/laundry.json")).resolves.toBeNull();
    await expect(storage.objectExists("latest/laundry.json")).resolves.toBe(false);
  });

  it("writes each commit to D1 in one batch and archives it through the R2 gateway", async () => {
    const d1Fetch = d1Success();
    const r2Fetch = vi.fn(async (_input: string | URL | Request, _request?: RequestInit) =>
      new Response(null, { status: 204 }));
    const storage = new CloudflareRestStorage(options, { d1: gateway(d1Fetch), fetch: r2Fetch });

    await storage.commit(commit);

    const body = JSON.parse(String(d1Fetch.mock.calls[0]?.[1]?.body)) as {
      batch: Array<{ sql: string; params: unknown[] }>;
    };
    expect(body.batch).toHaveLength(2);
    expect(body.batch[0]?.params.slice(0, 2)).toEqual(["laundry", 29_740_320]);
    expect(r2Fetch.mock.calls.map(([url]) => new URL(String(url)).searchParams.get("key"))).toEqual([
      "collector/commits/laundry/2026/07/20/29740320.json",
      "collector/latest/laundry.json",
      "collector/state/laundry.json",
    ]);
  });

  it("rejects failed D1 gateway query results", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      results: [{ success: false, results: [] }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const storage = new CloudflareRestStorage(options, {
      d1: gateway(fetchMock),
      fetch: vi.fn(async () => new Response(null, { status: 204 })),
    });

    await expect(storage.readState("laundry")).rejects.toThrow("unsuccessful query result");
  });
});
