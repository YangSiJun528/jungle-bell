import ky, { isHTTPError, type Options } from "ky";
import type { BinaryHttpResponse, JsonHttpResponse } from "./types";

export interface FetchJsonOptions {
  timeoutMs: number;
  retries: number;
  headers?: Record<string, string>;
}

export type FetchBinaryOptions = FetchJsonOptions;

function errorDetail(error: Error): string {
  if (!isHTTPError(error)) return error.message;

  const body = error.data === undefined
    ? ""
    : typeof error.data === "string"
      ? error.data
      : JSON.stringify(error.data);
  return `HTTP ${error.response.status}${body ? `: ${body.slice(0, 256)}` : ""}`;
}

function requestOptions(options: FetchJsonOptions): Options {
  return {
    ...(options.headers ? { headers: options.headers } : {}),
    timeout: options.timeoutMs,
    retry: {
      limit: options.retries,
      backoffLimit: 2_000,
      jitter: true,
      retryOnTimeout: true,
    },
    hooks: {
      beforeError: [({ error, retryCount }) => {
        error.message = `Request failed after ${retryCount + 1} attempts: ${errorDetail(error)}`;
        return error;
      }],
    },
  };
}

export async function fetchJson(url: string, options: FetchJsonOptions): Promise<JsonHttpResponse> {
  const startedAt = performance.now();
  const response = await ky.get(url, requestOptions(options));
  const raw = await response.text();
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

export async function fetchBinary(url: string, options: FetchBinaryOptions): Promise<BinaryHttpResponse> {
  const startedAt = performance.now();
  const response = await ky.get(url, requestOptions(options));
  return {
    body: new Uint8Array(await response.arrayBuffer()),
    contentType: response.headers.get("content-type")?.split(";", 1)[0]?.trim() || "application/octet-stream",
    status: response.status,
    fetchedAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - startedAt),
  };
}
