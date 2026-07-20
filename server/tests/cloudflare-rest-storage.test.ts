import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";
import type { CollectionCommit } from "../src/collector/types";
import {
  CloudflareRestStorage,
  type CloudflareRestStorageOptions,
} from "../src/node/cloudflare-rest-storage";

const options: CloudflareRestStorageOptions = {
  accountId: "account-id",
  databaseId: "database-id",
  apiToken: "d1-token",
  r2Bucket: "jungle-bell-data",
  r2AccessKeyId: "r2-key",
  r2SecretAccessKey: "r2-secret",
  requestRetries: 0,
};

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

function fakeS3() {
  const send = vi.fn(async (command: unknown) => {
    if (command instanceof PutObjectCommand) return {};
    throw new Error("Unexpected S3 command");
  });
  return { send, client: { send } as unknown as S3Client };
}

describe("CloudflareRestStorage", () => {
  it("reads source state through the authenticated D1 REST endpoint", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _request?: RequestInit) =>
      new Response(JSON.stringify({
        success: true,
        errors: [],
        result: [{
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
    const storage = new CloudflareRestStorage(options, { fetch: fetchMock, s3: fakeS3().client });

    const state = await storage.readState("laundry");

    expect(state?.lastResponseSha).toBe("a".repeat(64));
    const [url, request] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/account-id/d1/database/database-id/query",
    );
    expect(request?.headers).toMatchObject({ Authorization: "Bearer d1-token" });
    expect(JSON.parse(String(request?.body))).toMatchObject({ params: ["laundry"] });
  });

  it("writes each commit to D1 in one batch and archives it to R2", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, request?: RequestInit) => {
      const body = JSON.parse(String(request?.body)) as { batch: unknown[] };
      return new Response(JSON.stringify({
        success: true,
        errors: [],
        result: body.batch.map(() => ({ success: true, results: [] })),
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const s3 = fakeS3();
    const storage = new CloudflareRestStorage(options, { fetch: fetchMock, s3: s3.client });

    await storage.commit(commit);

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      batch: Array<{ sql: string; params: unknown[] }>;
    };
    expect(body.batch).toHaveLength(2);
    expect(body.batch[0]?.params.slice(0, 2)).toEqual(["laundry", 29_740_320]);
    const keys = s3.send.mock.calls
      .map(([command]) => command)
      .filter((command) => command instanceof PutObjectCommand)
      .map((command) => command.input.Key);
    expect(keys).toEqual([
      "collector/commits/laundry/2026/07/20/29740320.json",
      "collector/latest/laundry.json",
      "collector/state/laundry.json",
    ]);
  });

  it("rejects unsuccessful D1 query results", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      success: true,
      errors: [],
      result: [{ success: false, results: [] }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const storage = new CloudflareRestStorage(options, { fetch: fetchMock, s3: fakeS3().client });

    await expect(storage.readState("laundry")).rejects.toThrow("unsuccessful query result");
  });
});
