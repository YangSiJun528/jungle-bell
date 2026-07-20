import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type PutObjectCommandInput,
} from "@aws-sdk/client-s3";
import { getLogger } from "@logtape/logtape";
import { datedObjectPath, latestCollectionCommitPath } from "../collector/time";
import type {
  BinaryObject,
  CollectionCommit,
  CollectorStorage,
  SourceName,
  SourceState,
} from "../collector/types";
import { buildD1CommitQueries, type D1Query } from "../storage/d1-commit";

interface D1ErrorDetail {
  code?: number;
  message?: string;
}

interface D1QueryResult {
  success?: boolean;
  results?: unknown[];
}

interface D1Response {
  success?: boolean;
  result?: D1QueryResult[];
  errors?: D1ErrorDetail[];
}

interface SourceStateRow {
  source: SourceName;
  last_attempt_at: string;
  last_success_at: string | null;
  last_response_sha: string | null;
  last_raw_key: string | null;
  last_normalized_key: string | null;
  version_first_seen_at: string | null;
  consecutive_failures: number;
  last_error: string | null;
}

export interface CloudflareRestStorageOptions {
  accountId: string;
  databaseId: string;
  apiToken: string;
  r2Bucket: string;
  r2AccessKeyId: string;
  r2SecretAccessKey: string;
  r2Endpoint?: string;
  requestTimeoutMs?: number;
  requestRetries?: number;
}

interface CloudflareRestStorageDependencies {
  fetch?: typeof globalThis.fetch;
  s3?: S3Client;
}

class D1ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "D1ApiError";
  }
}

const logger = getLogger(["jungle-bell", "cloudflare-rest-storage"]);

function toSourceState(row: SourceStateRow): SourceState {
  return {
    source: row.source,
    lastAttemptAt: row.last_attempt_at,
    lastSuccessAt: row.last_success_at,
    lastResponseSha: row.last_response_sha,
    lastRawKey: row.last_raw_key,
    lastNormalizedKey: row.last_normalized_key,
    versionFirstSeenAt: row.version_first_seen_at,
    consecutiveFailures: row.consecutive_failures,
    lastError: row.last_error,
  };
}

function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return value.name === "NoSuchKey" || value.name === "NotFound" || value.$metadata?.httpStatusCode === 404;
}

function d1ErrorMessage(status: number, response: D1Response | null, raw: string): string {
  const details = response?.errors
    ?.map((error) => [error.code, error.message].filter((value) => value !== undefined).join(": "))
    .filter(Boolean)
    .join("; ");
  const fallback = raw.trim().slice(0, 500);
  return `D1 request failed with HTTP ${status}${details ? `: ${details}` : fallback ? `: ${fallback}` : ""}`;
}

function retryDelayMs(response: Response | null, attempt: number): number {
  const retryAfter = response?.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, 60_000);
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) return Math.max(0, Math.min(date - Date.now(), 60_000));
  }
  return Math.min(500 * 2 ** attempt, 10_000);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class CloudflareRestStorage implements CollectorStorage {
  private readonly d1Url: string;
  private readonly fetchImplementation: typeof globalThis.fetch;
  private readonly s3: S3Client;
  private readonly timeoutMs: number;
  private readonly retries: number;

  constructor(
    private readonly options: CloudflareRestStorageOptions,
    dependencies: CloudflareRestStorageDependencies = {},
  ) {
    this.d1Url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(options.accountId)}`
      + `/d1/database/${encodeURIComponent(options.databaseId)}/query`;
    this.fetchImplementation = dependencies.fetch ?? globalThis.fetch;
    this.timeoutMs = options.requestTimeoutMs ?? 30_000;
    this.retries = options.requestRetries ?? 3;
    this.s3 = dependencies.s3 ?? new S3Client({
      region: "auto",
      endpoint: options.r2Endpoint ?? `https://${options.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: options.r2AccessKeyId,
        secretAccessKey: options.r2SecretAccessKey,
      },
      maxAttempts: this.retries + 1,
    });
  }

  private async queryD1<T>(query: D1Query): Promise<T[]> {
    const results = await this.requestD1(query);
    return (results[0]?.results ?? []) as T[];
  }

  private async requestD1(body: D1Query | { batch: D1Query[] }): Promise<D1QueryResult[]> {
    let lastError: unknown = null;

    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      let response: Response | null = null;
      try {
        response = await this.fetchImplementation(this.d1Url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.options.apiToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        const raw = await response.text();
        const retryable = response.status === 429 || response.status >= 500;
        if (retryable && attempt < this.retries) {
          await sleep(retryDelayMs(response, attempt));
          continue;
        }

        let parsed: D1Response | null = null;
        try {
          parsed = JSON.parse(raw) as D1Response;
        } catch {
          if (response.ok) throw new D1ApiError("D1 returned invalid JSON", response.status);
        }
        if (!response.ok || parsed?.success !== true || !Array.isArray(parsed.result)) {
          throw new D1ApiError(d1ErrorMessage(response.status, parsed, raw), response.status);
        }
        if (parsed.result.some((result) => result.success !== true)) {
          throw new D1ApiError("D1 returned an unsuccessful query result", response.status);
        }
        return parsed.result;
      } catch (error) {
        lastError = error;
        const retryable = !(error instanceof D1ApiError) || error.status === 429 || error.status >= 500;
        if (!retryable || attempt >= this.retries) throw error;
        await sleep(retryDelayMs(response, attempt));
      } finally {
        clearTimeout(timeout);
      }
    }

    throw lastError instanceof Error ? lastError : new Error("D1 request failed");
  }

  async readState(source: SourceName): Promise<SourceState | null> {
    const rows = await this.queryD1<SourceStateRow>({
      sql: "SELECT * FROM source_state WHERE source = ?",
      params: [source],
    });
    return rows[0] ? toSourceState(rows[0]) : null;
  }

  async readJson<T>(key: string): Promise<T | null> {
    try {
      const object = await this.s3.send(new GetObjectCommand({ Bucket: this.options.r2Bucket, Key: key }));
      if (!object.Body) throw new Error(`R2 object has no body: ${key}`);
      return JSON.parse(await object.Body.transformToString()) as T;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async writeJson(key: string, value: unknown): Promise<void> {
    await this.putObject(key, JSON.stringify(value), "application/json; charset=utf-8");
  }

  async writeRaw(key: string, raw: string): Promise<void> {
    await this.putObject(key, raw, "application/json; charset=utf-8");
  }

  async objectExists(key: string): Promise<boolean> {
    try {
      await this.s3.send(new HeadObjectCommand({ Bucket: this.options.r2Bucket, Key: key }));
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  async writeBinary(key: string, object: BinaryObject): Promise<void> {
    await this.putObject(key, object.body, object.contentType, object.etag);
  }

  private async putObject(
    key: string,
    body: string | Uint8Array,
    contentType: string,
    etag?: string,
  ): Promise<void> {
    const input: PutObjectCommandInput = {
      Bucket: this.options.r2Bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    };
    if (etag) input.Metadata = { sha256: etag };
    await this.s3.send(new PutObjectCommand(input));
  }

  private async archiveCommit(commit: CollectionCommit): Promise<void> {
    const { observation, state } = commit;
    const key = datedObjectPath(
      `collector/commits/${observation.source}`,
      new Date(observation.scheduledAt),
      `${observation.minuteEpoch}.json`,
    );
    try {
      await this.writeJson(key, commit);
      await this.writeJson(latestCollectionCommitPath(observation.source), commit);
      await this.writeJson(`collector/state/${state.source}.json`, state);
    } catch (error) {
      logger.error("D1 commit succeeded but R2 commit archive failed", {
        source: observation.source,
        minuteEpoch: observation.minuteEpoch,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async commit(commit: CollectionCommit): Promise<void> {
    await this.requestD1({ batch: await buildD1CommitQueries(commit) });
    await this.archiveCommit(commit);
  }
}
