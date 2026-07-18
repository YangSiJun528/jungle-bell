import { describe, expect, it } from "vitest";
import type { CollectionCommit, SourceState } from "../src/collector/types";
import {
  CloudflareApiStorage,
  CloudflareCollectorStorage,
  latestCollectionCommitKey,
} from "../src/workers/cloudflare-storage";

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

function memoryBucket(): { bucket: R2Bucket; objects: Map<string, string> } {
  const objects = new Map<string, string>();
  const bucket = {
    put: async (key: string, value: string) => {
      objects.set(key, value);
      return {};
    },
    get: async (key: string) => {
      const value = objects.get(key);
      return value === undefined ? null : { text: async () => value };
    },
    head: async (key: string) => objects.has(key) ? {} : null,
  } as unknown as R2Bucket;
  return { bucket, objects };
}

describe("Cloudflare storage boundaries", () => {
  it("archives collector commits and state in R2 without D1", async () => {
    const { bucket, objects } = memoryBucket();
    const storage = new CloudflareCollectorStorage(bucket);
    const value = commit();

    await storage.commit(value);

    expect(objects.has("collector/commits/laundry/2026/07/18/29738880.json")).toBe(true);
    expect(objects.has(latestCollectionCommitKey("laundry"))).toBe(true);
    await expect(storage.readState("laundry")).resolves.toEqual(value.state);
  });

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
    const { bucket } = memoryBucket();

    await new CloudflareApiStorage(db, bucket).applyCommit(commit());

    expect(statements).toHaveLength(2);
    expect(statements.some(({ sql }) => sql.includes("minute_observation"))).toBe(true);
    expect(statements.some(({ sql }) => sql.includes("source_state"))).toBe(true);
    expect(statements.some(({ sql }) => sql.includes("source_version"))).toBe(false);
  });
});
