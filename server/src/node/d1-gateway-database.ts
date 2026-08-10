type D1GatewayValue = string | number | null;

interface D1GatewayQuery {
  sql: string;
  params: D1GatewayValue[];
}

interface D1GatewayResponse {
  results?: Array<{
    success?: boolean;
    results?: Record<string, unknown>[];
    meta?: Record<string, unknown> & { changes?: number; last_row_id?: number };
  }>;
  error?: string;
}

export interface D1GatewayDatabaseOptions {
  url: string;
  sharedSecret: string;
  requestTimeoutMs?: number;
  requestRetries?: number;
}

interface D1GatewayDatabaseDependencies {
  fetch?: typeof globalThis.fetch;
  sleep?: (milliseconds: number) => Promise<void>;
}

class D1GatewayError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "D1GatewayError";
  }
}

function bindingValue(value: unknown): D1GatewayValue {
  if (value === null || typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  throw new TypeError(`Unsupported D1 gateway binding type: ${typeof value}`);
}

function retryDelayMs(response: Response | null, attempt: number): number {
  const retryAfter = response?.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, 60_000);
  }
  return Math.min(500 * 2 ** attempt, 10_000);
}

class D1GatewayPreparedStatement {
  constructor(
    private readonly database: D1GatewayDatabase,
    readonly query: D1GatewayQuery,
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    return new D1GatewayPreparedStatement(this.database, {
      sql: this.query.sql,
      params: values.map(bindingValue),
    }) as unknown as D1PreparedStatement;
  }

  all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return this.database.execute<T>(this.query);
  }

  run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return this.database.execute<T>(this.query);
  }

  async first<T = Record<string, unknown>>(columnName?: string): Promise<T | null> {
    const result = await this.database.execute<Record<string, unknown>>(this.query);
    const first = result.results[0];
    if (!first) return null;
    if (columnName === undefined) return first as T;
    if (!(columnName in first)) throw new Error(`D1 first() column does not exist: ${columnName}`);
    return first[columnName] as T;
  }

  queryFor(database: D1GatewayDatabase): D1GatewayQuery {
    if (this.database !== database) {
      throw new TypeError("D1 gateway batch only accepts statements prepared by the same adapter");
    }
    return { sql: this.query.sql, params: [...this.query.params] };
  }
}

/** Minimal D1Database-compatible adapter for the authenticated App Worker gateway. */
export class D1GatewayDatabase {
  private readonly fetchImplementation: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(
    private readonly options: D1GatewayDatabaseOptions,
    dependencies: D1GatewayDatabaseDependencies = {},
  ) {
    const url = new URL(options.url);
    if (url.protocol !== "https:" || url.pathname !== "/internal/jobs/d1" || url.search || url.hash) {
      throw new Error("JOBS_D1_GATEWAY_URL must be an exact HTTPS /internal/jobs/d1 endpoint");
    }
    if (options.sharedSecret.length < 32) throw new Error("JOBS_D1_GATEWAY_SECRET must be at least 32 characters");
    this.fetchImplementation = dependencies.fetch ?? globalThis.fetch;
    this.timeoutMs = options.requestTimeoutMs ?? 30_000;
    this.retries = options.requestRetries ?? 3;
    this.sleep = dependencies.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  prepare(sql: string): D1PreparedStatement {
    if (!sql.trim()) throw new Error("D1 SQL must not be empty");
    return new D1GatewayPreparedStatement(this, { sql, params: [] }) as unknown as D1PreparedStatement;
  }

  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    const queries = statements.map((statement) => {
      if (!(statement instanceof D1GatewayPreparedStatement)) {
        throw new TypeError("D1 gateway batch only accepts statements prepared by the same adapter");
      }
      return statement.queryFor(this);
    });
    if (queries.length === 0) return [];
    return this.request<T>({ batch: queries });
  }

  async execute<T = Record<string, unknown>>(query: D1GatewayQuery): Promise<D1Result<T>> {
    const results = await this.request<T>(query);
    const result = results[0];
    if (!result) throw new Error("D1 gateway returned no query result");
    return result;
  }

  private async request<T>(body: D1GatewayQuery | { batch: D1GatewayQuery[] }): Promise<D1Result<T>[]> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      let response: Response | null = null;
      try {
        response = await this.fetchImplementation(this.options.url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.options.sharedSecret}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: controller.signal,
          cache: "no-store",
        });
        const parsed = await response.json() as D1GatewayResponse;
        const retryable = response.status === 429 || response.status >= 500;
        if (retryable && attempt < this.retries) {
          await this.sleep(retryDelayMs(response, attempt));
          continue;
        }
        if (!response.ok || !Array.isArray(parsed.results)) {
          throw new D1GatewayError(`D1 gateway request failed with HTTP ${response.status}: ${parsed.error ?? "UNKNOWN"}`, response.status);
        }
        if (parsed.results.some((result) => result.success !== true)) {
          throw new D1GatewayError("D1 gateway returned an unsuccessful query result", response.status);
        }
        return parsed.results.map((result) => ({
          success: true,
          results: (result.results ?? []) as T[],
          meta: {
            ...(result.meta ?? {}),
            changes: result.meta?.changes ?? 0,
            last_row_id: result.meta?.last_row_id ?? 0,
          },
        })) as D1Result<T>[];
      } catch (error) {
        lastError = error;
        const retryable = !(error instanceof D1GatewayError)
          || error.status === 429
          || error.status >= 500;
        if (!retryable || attempt >= this.retries) throw error;
        await this.sleep(retryDelayMs(response, attempt));
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastError instanceof Error ? lastError : new Error("D1 gateway request failed");
  }
}
