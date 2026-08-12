import { getLogger } from "@logtape/logtape";
import { datedObjectPath, latestCollectionCommitPath } from "@jungle-bell/backend-common/collection/time";
import type {
  CollectionCommit,
  SourceName,
  SourceState,
} from "@jungle-bell/backend-common/collection/types";
import type { BinaryObject, CollectorStorage } from "@jungle-bell/backend-common/ports/collector-storage";
import type { SqlDatabase } from "@jungle-bell/backend-common/ports/sql-database";
import { buildD1CommitQueries, type D1Query } from "./d1-commit-queries";

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
  r2GatewayUrl: string;
  sharedSecret: string;
  r2RequestTimeoutMs?: number;
  r2RequestRetries?: number;
}

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface CloudflareRestStorageDependencies {
  fetch?: Fetch;
  d1: Pick<SqlDatabase, "prepare" | "batch">;
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

function retryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export class CloudflareRestStorage implements CollectorStorage {
  private readonly d1: Pick<SqlDatabase, "prepare" | "batch">;
  private readonly fetch: Fetch;
  private readonly retries: number;
  private readonly timeoutMs: number;
  private readonly gatewayUrl: URL;

  constructor(
    private readonly options: CloudflareRestStorageOptions,
    dependencies: CloudflareRestStorageDependencies,
  ) {
    const gatewayUrl = new URL(options.r2GatewayUrl);
    if (gatewayUrl.protocol !== "https:" || gatewayUrl.pathname !== "/internal/jobs/r2"
      || gatewayUrl.search || gatewayUrl.hash) {
      throw new Error("R2 gateway URL must be an exact HTTPS /internal/jobs/r2 endpoint");
    }
    if (options.sharedSecret.trim().length < 32) throw new Error("R2 gateway shared secret is too short");
    this.gatewayUrl = gatewayUrl;
    this.retries = options.r2RequestRetries ?? 3;
    this.timeoutMs = options.r2RequestTimeoutMs ?? 30_000;
    this.d1 = dependencies.d1;
    this.fetch = dependencies.fetch ?? globalThis.fetch;
  }

  private async queryD1<T>(query: D1Query): Promise<T[]> {
    const result = await this.d1.prepare(query.sql).bind(...query.params).all<T>();
    return result.results;
  }

  private objectUrl(key: string): URL {
    const url = new URL(this.gatewayUrl);
    url.searchParams.set("key", key);
    return url;
  }

  private async request(method: "GET" | "HEAD" | "PUT", key: string, init: RequestInit = {}): Promise<Response> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetch(this.objectUrl(key), {
          ...init,
          method,
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${this.options.sharedSecret}`,
            ...init.headers,
          },
        });
        if (!retryableStatus(response.status) || attempt === this.retries) return response;
        await response.body?.cancel();
        lastError = new Error(`R2 gateway returned HTTP ${response.status}`);
      } catch (error) {
        lastError = error;
        if (attempt === this.retries) throw error;
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastError instanceof Error ? lastError : new Error("R2 gateway request failed");
  }

  private async successful(method: "GET" | "HEAD" | "PUT", key: string, init?: RequestInit): Promise<Response> {
    const response = await this.request(method, key, init);
    if (response.ok) return response;
    await response.body?.cancel();
    throw new Error(`R2 gateway ${method} failed with HTTP ${response.status}`);
  }

  async readState(source: SourceName): Promise<SourceState | null> {
    const rows = await this.queryD1<SourceStateRow>({
      sql: "SELECT * FROM source_state WHERE source = ?",
      params: [source],
    });
    return rows[0] ? toSourceState(rows[0]) : null;
  }

  async readJson<T>(key: string): Promise<T | null> {
    const response = await this.request("GET", key);
    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`R2 gateway GET failed with HTTP ${response.status}`);
    }
    return await response.json() as T;
  }

  async writeJson(key: string, value: unknown): Promise<void> {
    await this.putObject(key, JSON.stringify(value), "application/json; charset=utf-8");
  }

  async writeRaw(key: string, raw: string): Promise<void> {
    await this.putObject(key, raw, "application/json; charset=utf-8");
  }

  async objectExists(key: string): Promise<boolean> {
    const response = await this.request("HEAD", key);
    if (response.status === 404) return false;
    if (!response.ok) throw new Error(`R2 gateway HEAD failed with HTTP ${response.status}`);
    return true;
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
    const byteLength = typeof body === "string" ? new TextEncoder().encode(body).byteLength : body.byteLength;
    const requestBody: RequestInit["body"] = typeof body === "string" ? body : Uint8Array.from(body).buffer;
    await this.successful("PUT", key, {
      body: requestBody,
      headers: {
        "Content-Length": String(byteLength),
        "Content-Type": contentType,
        ...(etag ? { "X-Jungle-Bell-Sha256": etag } : {}),
      },
    });
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
    const queries = await buildD1CommitQueries(commit);
    await this.d1.batch(queries.map((query) => this.d1.prepare(query.sql).bind(...query.params)));
    await this.archiveCommit(commit);
  }
}
