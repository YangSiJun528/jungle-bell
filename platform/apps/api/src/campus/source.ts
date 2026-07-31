import type { z } from "zod";

import {
  mealHistoryPageSchema,
  mealsResponseSchema,
  laundryResponseSchema,
  type CampusDataByKind,
  type CampusKind,
  type MealHistoryPage,
} from "./contracts.js";

export const DEFAULT_CAMPUS_REQUEST_TIMEOUT_MS = 10_000;
export const DEFAULT_CAMPUS_RESPONSE_LIMIT_BYTES = 2 * 1024 * 1024;

export interface CampusSourceRequest {
  readonly ifNoneMatch?: string;
}

export type CampusSourceResponse<T> =
  | {
      readonly status: "not-modified";
      readonly etag: string | null;
      readonly checkedAtEpochMs: number;
    }
  | {
      readonly status: "modified";
      readonly etag: string | null;
      readonly checkedAtEpochMs: number;
      readonly data: T;
    };

export interface CampusDataSource {
  fetch<K extends CampusKind>(
    kind: K,
    request?: CampusSourceRequest,
  ): Promise<CampusSourceResponse<CampusDataByKind[K]>>;
  fetchMealHistory(input?: {
    readonly before?: string;
    readonly limit?: number;
  }): Promise<MealHistoryPage>;
}

export interface HttpCampusDataSourceOptions {
  readonly baseUrl: string;
  readonly timeoutMs?: number;
  readonly responseLimitBytes?: number;
  readonly userAgent?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
}

export class CampusSourceError extends Error {
  constructor(
    readonly code:
      | "INVALID_CONFIGURATION"
      | "TIMEOUT"
      | "HTTP_ERROR"
      | "RESPONSE_TOO_LARGE"
      | "INVALID_CONTENT_TYPE"
      | "INVALID_JSON"
      | "INVALID_SCHEMA",
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = "CampusSourceError";
  }
}

export class HttpCampusDataSource implements CampusDataSource {
  private readonly baseUrl: URL;
  private readonly timeoutMs: number;
  private readonly responseLimitBytes: number;
  private readonly userAgent: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly now: () => number;

  constructor(options: HttpCampusDataSourceOptions) {
    this.baseUrl = parseBaseUrl(options.baseUrl);
    this.timeoutMs =
      options.timeoutMs ?? DEFAULT_CAMPUS_REQUEST_TIMEOUT_MS;
    this.responseLimitBytes =
      options.responseLimitBytes ?? DEFAULT_CAMPUS_RESPONSE_LIMIT_BYTES;
    this.userAgent = options.userAgent ?? "JungleBell-Platform/0.1";
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    if (
      !Number.isSafeInteger(this.timeoutMs) ||
      this.timeoutMs <= 0 ||
      !Number.isSafeInteger(this.responseLimitBytes) ||
      this.responseLimitBytes <= 0
    ) {
      throw new CampusSourceError(
        "INVALID_CONFIGURATION",
        "Campus request limits must be positive safe integers.",
      );
    }
  }

  async fetch<K extends CampusKind>(
    kind: K,
    request: CampusSourceRequest = {},
  ): Promise<CampusSourceResponse<CampusDataByKind[K]>> {
    const path =
      kind === "laundry" ? "/v1/laundry/latest" : "/v1/meals";
    return this.withResponse(
      path,
      request.ifNoneMatch,
      async (response, signal) => {
        const checkedAtEpochMs = this.now();
        const etag = response.headers.get("etag");
        if (response.status === 304) {
          return { status: "not-modified", etag, checkedAtEpochMs };
        }
        await assertSuccessfulJsonResponse(response);
        const raw = await readResponseText(
          response,
          this.responseLimitBytes,
          signal,
        );
        const data = parseJson(raw);
        const parsed =
          kind === "laundry"
            ? parseSchema(laundryResponseSchema, data, kind)
            : parseSchema(mealsResponseSchema, data, kind);
        return {
          status: "modified",
          etag,
          checkedAtEpochMs,
          data: parsed as CampusDataByKind[K],
        };
      },
    );
  }

  async fetchMealHistory(
    input: {
      readonly before?: string;
      readonly limit?: number;
    } = {},
  ): Promise<MealHistoryPage> {
    const url = new URL("/v1/meals/history", this.baseUrl);
    if (input.before !== undefined) {
      url.searchParams.set("before", input.before);
    }
    if (input.limit !== undefined) {
      if (
        !Number.isSafeInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > 100
      ) {
        throw new TypeError("Meal history limit must be between 1 and 100.");
      }
      url.searchParams.set("limit", String(input.limit));
    }
    return this.withResponse(url, undefined, async (response, signal) => {
      await assertSuccessfulJsonResponse(response);
      const raw = await readResponseText(
        response,
        this.responseLimitBytes,
        signal,
      );
      return parseSchema(
        mealHistoryPageSchema,
        parseJson(raw),
        "meal history",
      );
    });
  }

  private async withResponse<T>(
    pathOrUrl: string | URL,
    ifNoneMatch?: string,
    consume?: (
      response: Response,
      signal: AbortSignal,
    ) => Promise<T>,
  ): Promise<T> {
    if (consume === undefined) {
      throw new TypeError("Campus response consumer is required.");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": this.userAgent,
    };
    if (ifNoneMatch !== undefined) {
      headers["If-None-Match"] = ifNoneMatch;
    }
    try {
      const response = await this.fetchImpl(
        typeof pathOrUrl === "string"
          ? new URL(pathOrUrl, this.baseUrl)
          : pathOrUrl,
        {
          method: "GET",
          headers,
          redirect: "error",
          signal: controller.signal,
        },
      );
      return await consume(response, controller.signal);
    } catch (error) {
      if (controller.signal.aborted) {
        throw new CampusSourceError(
          "TIMEOUT",
          `Campus request exceeded ${this.timeoutMs}ms.`,
          { cause: error },
        );
      }
      if (error instanceof CampusSourceError) {
        throw error;
      }
      throw new CampusSourceError(
        "HTTP_ERROR",
        "Campus request failed.",
        { cause: error },
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

export function campusDataSourceFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  overrides: Omit<HttpCampusDataSourceOptions, "baseUrl"> = {},
): HttpCampusDataSource {
  const baseUrl = environment.JB_CAMPUS_DATA_API_URL;
  if (!baseUrl) {
    throw new CampusSourceError(
      "INVALID_CONFIGURATION",
      "JB_CAMPUS_DATA_API_URL is required.",
    );
  }
  if (environment.NODE_ENV === "production") {
    let protocol: string;
    try {
      protocol = new URL(baseUrl).protocol;
    } catch {
      protocol = "";
    }
    if (protocol !== "https:") {
      throw new CampusSourceError(
        "INVALID_CONFIGURATION",
        "JB_CAMPUS_DATA_API_URL must use HTTPS in production.",
      );
    }
  }
  return new HttpCampusDataSource({ ...overrides, baseUrl });
}

function parseBaseUrl(value: string): URL {
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.search !== "" ||
      parsed.hash !== ""
    ) {
      throw new Error("unsupported URL");
    }
    if (!parsed.pathname.endsWith("/")) {
      parsed.pathname += "/";
    }
    return parsed;
  } catch (error) {
    throw new CampusSourceError(
      "INVALID_CONFIGURATION",
      "JB_CAMPUS_DATA_API_URL must be an HTTP(S) base URL.",
      { cause: error },
    );
  }
}

async function assertSuccessfulJsonResponse(
  response: Response,
): Promise<void> {
  if (!response.ok) {
    throw new CampusSourceError(
      "HTTP_ERROR",
      `Campus API returned HTTP ${response.status}.`,
    );
  }
  const contentType = response.headers.get("content-type");
  if (
    contentType !== null &&
    !/^application\/(?:[a-z0-9.+-]*\+)?json(?:\s*;|$)/iu.test(
      contentType,
    )
  ) {
    throw new CampusSourceError(
      "INVALID_CONTENT_TYPE",
      "Campus API did not return JSON.",
    );
  }
}

async function readResponseText(
  response: Response,
  limitBytes: number,
  signal: AbortSignal,
): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    Number.isFinite(Number(declaredLength)) &&
    Number(declaredLength) > limitBytes
  ) {
    throw new CampusSourceError(
      "RESPONSE_TOO_LARGE",
      `Campus response exceeded ${limitBytes} bytes.`,
    );
  }
  if (response.body === null) {
    return "";
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await readWithAbort(reader, signal);
      if (result.done) break;
      total += result.value.byteLength;
      if (total > limitBytes) {
        await reader.cancel();
        throw new CampusSourceError(
          "RESPONSE_TOO_LARGE",
          `Campus response exceeded ${limitBytes} bytes.`,
        );
      }
      chunks.push(result.value);
    }
  } finally {
    if (signal.aborted) {
      try {
        await reader.cancel();
      } catch {
        // The transport may already have closed the response body.
      }
    }
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

async function readWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) {
    throw signal.reason;
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    reader.read().then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new CampusSourceError(
      "INVALID_JSON",
      "Campus response was not valid JSON.",
      { cause: error },
    );
  }
}

function parseSchema<T>(
  schema: z.ZodType<T>,
  value: unknown,
  name: string,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new CampusSourceError(
      "INVALID_SCHEMA",
      `Campus ${name} response did not match the supported schema.`,
      { cause: parsed.error },
    );
  }
  return parsed.data;
}
