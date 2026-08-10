import ky from "ky";
import type { BinaryHttpResponse, JsonHttpResponse } from "./types";

export interface FetchJsonOptions {
  timeoutMs: number;
  retries: number;
  headers?: Record<string, string>;
  maxBytes?: number;
}

export interface FetchBinaryOptions extends FetchJsonOptions {
  allowedHosts?: readonly string[];
  maxBytes?: number;
  maxRedirects?: number;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_JSON_RESPONSE_BYTES = 4 * 1024 * 1024;

export async function fetchJson(url: string, options: FetchJsonOptions): Promise<JsonHttpResponse> {
  const startedAt = performance.now();
  const response = await jsonRequest(url, options);
  const raw = new TextDecoder().decode(response.body);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Response was not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return {
    raw,
    value,
    status: response.status,
    fetchedAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - startedAt),
  };
}

interface BufferedJsonResponse {
  body: Uint8Array;
  status: number;
}

async function jsonRequest(url: string, options: FetchJsonOptions): Promise<BufferedJsonResponse> {
  const requestUrl = checkedJsonUrl(url);
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= options.retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("JSON request timed out")), options.timeoutMs);
    let retryDelay = Math.min(250 * 2 ** attempt, 2_000);
    try {
      const response = await ky.get(requestUrl, {
        ...(options.headers ? { headers: options.headers } : {}),
        timeout: false,
        redirect: "manual",
        retry: 0,
        throwHttpErrors: false,
        signal: controller.signal,
      });
      const body = await limitedBody(response, options.maxBytes ?? MAX_JSON_RESPONSE_BYTES);
      if (response.ok) return { body, status: response.status };
      const error = new Error(`HTTP ${response.status}`);
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      if (!retryable || attempt === options.retries) {
        throw new RequestAttemptsError(attempt + 1, error.message);
      }
      retryDelay = retryAfterDelay(response, retryDelay);
      lastError = error;
    } catch (error) {
      if (error instanceof RequestAttemptsError || error instanceof ResponseBodyLimitError) throw error;
      lastError = error;
      if (attempt === options.retries) {
        throw new RequestAttemptsError(attempt + 1, error instanceof Error ? error.message : String(error));
      }
    } finally {
      clearTimeout(timeout);
    }
    await new Promise((resolve) => setTimeout(resolve, retryDelay));
  }
  throw lastError instanceof Error ? lastError : new Error("JSON request failed");
}

function checkedJsonUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) {
    throw new Error(`JSON URL is not allowed: ${url.origin}`);
  }
  return url.href;
}

class RequestAttemptsError extends Error {
  constructor(attempts: number, detail: string) {
    super(`Request failed after ${attempts} attempts: ${detail}`);
    this.name = "RequestAttemptsError";
  }
}

class ResponseBodyLimitError extends Error {
  constructor(maxBytes: number) {
    super(`Response exceeded ${maxBytes} bytes`);
    this.name = "ResponseBodyLimitError";
  }
}

function retryAfterDelay(response: Response, fallback: number): number {
  const seconds = Number(response.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds * 1_000, 60_000) : fallback;
}

export async function fetchBinary(url: string, options: FetchBinaryOptions): Promise<BinaryHttpResponse> {
  const startedAt = performance.now();
  const allowedHosts = new Set(options.allowedHosts ?? []);
  let currentUrl = checkedBinaryUrl(url, allowedHosts);
  let active: TimedResponse | null = null;
  const redirectLimit = options.maxRedirects ?? 3;
  for (let redirectCount = 0; redirectCount <= redirectLimit; redirectCount += 1) {
    active = await binaryRequest(currentUrl, options);
    if (!REDIRECT_STATUSES.has(active.response.status)) break;
    try {
      if (redirectCount === redirectLimit) throw new Error(`Binary response exceeded ${redirectLimit} redirects`);
      const location = active.response.headers.get("location");
      if (!location) throw new Error("Binary redirect did not include a Location header");
      currentUrl = checkedBinaryUrl(new URL(location, currentUrl).href, allowedHosts);
    } finally {
      try {
        await active.response.body?.cancel();
      } finally {
        active.finish();
        active = null;
      }
    }
  }
  if (!active) throw new Error("Binary request returned no response");
  const response = active.response;
  try {
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Binary request failed with HTTP ${response.status}`);
    }
    const body = await limitedBody(response, options.maxBytes ?? Number.MAX_SAFE_INTEGER);
    return {
      body,
      contentType: response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() || "application/octet-stream",
      status: response.status,
      fetchedAt: new Date().toISOString(),
      durationMs: Math.round(performance.now() - startedAt),
    };
  } finally {
    active.finish();
  }
}

interface TimedResponse {
  response: Response;
  finish(): void;
}

async function binaryRequest(url: string, options: FetchBinaryOptions): Promise<TimedResponse> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= options.retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("Binary request timed out")), options.timeoutMs);
    const finish = () => clearTimeout(timeout);
    try {
      const response = await ky.get(url, {
        ...(options.headers ? { headers: options.headers } : {}),
        timeout: false,
        redirect: "manual",
        retry: 0,
        throwHttpErrors: false,
        signal: controller.signal,
      });
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      if (!retryable || attempt === options.retries) return { response, finish };
      await response.body?.cancel();
      finish();
    } catch (error) {
      lastError = error;
      finish();
      if (attempt === options.retries) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(250 * 2 ** attempt, 2_000)));
  }
  throw lastError instanceof Error ? lastError : new Error("Binary request failed");
}

function checkedBinaryUrl(value: string, allowedHosts: ReadonlySet<string>): string {
  const url = new URL(value);
  const allowed = allowedHosts.size === 0 || allowedHosts.has(url.hostname.toLowerCase());
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") || !allowed) {
    throw new Error(`Binary URL is not allowed: ${url.origin}`);
  }
  return url.href;
}

async function limitedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new ResponseBodyLimitError(maxBytes);
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    length += result.value.byteLength;
    if (length > maxBytes) {
      await reader.cancel();
      throw new ResponseBodyLimitError(maxBytes);
    }
    chunks.push(result.value);
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}
