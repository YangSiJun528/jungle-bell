import ky, { HTTPError } from "ky";
import type { BinaryHttpResponse, JsonHttpResponse } from "./types";

export interface FetchJsonOptions {
  timeoutMs: number;
  retries: number;
  headers?: Record<string, string>;
}

export type FetchBinaryOptions = FetchJsonOptions;

function requestOptions(options: FetchJsonOptions) {
  return {
    ...(options.headers ? { headers: options.headers } : {}),
    redirect: "follow" as const,
    timeout: options.timeoutMs,
    retry: {
      limit: options.retries,
      methods: ["get"],
      statusCodes: [408, 413, 429, 500, 502, 503, 504],
      afterStatusCodes: [413, 429, 503],
      backoffLimit: 2_000,
      jitter: true,
      retryOnTimeout: true,
    },
  };
}

async function errorMessage(error: unknown): Promise<string> {
  if (error instanceof HTTPError) {
    const body = typeof error.data === "string"
      ? error.data
      : error.data === undefined ? "" : JSON.stringify(error.data);
    return `HTTP ${error.response.status}${body ? `: ${body.slice(0, 256)}` : ""}`;
  }
  return error instanceof Error ? error.message : String(error);
}

export async function fetchJson(url: string, options: FetchJsonOptions): Promise<JsonHttpResponse> {
  const startedAt = performance.now();
  let response: Response;
  try {
    response = await ky.get(url, requestOptions(options));
  } catch (error) {
    throw new Error(`Request failed after ${options.retries + 1} attempts: ${await errorMessage(error)}`);
  }
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
  try {
    const response = await ky.get(url, requestOptions(options));
    return {
      body: new Uint8Array(await response.arrayBuffer()),
      contentType: response.headers.get("content-type")?.split(";", 1)[0]?.trim() || "application/octet-stream",
      status: response.status,
      fetchedAt: new Date().toISOString(),
      durationMs: Math.round(performance.now() - startedAt),
    };
  } catch (error) {
    throw new Error(`Binary request failed after ${options.retries + 1} attempts: ${await errorMessage(error)}`);
  }
}
