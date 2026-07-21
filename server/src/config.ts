import type { CollectorOptions } from "./types";
import { z } from "zod";

export const DEFAULT_COLLECTOR_URLS = {
  laundry: "https://miracle-beautifully-onto-ser.trycloudflare.com/api/status",
  mealsIncludePinned: "https://pf.kakao.com/rocket-web/web/profiles/_xhzNjn/posts?includePinnedPost=true",
  mealsDefault: "https://pf.kakao.com/rocket-web/web/profiles/_xhzNjn/posts",
  mealsPage: "https://pf.kakao.com/_xhzNjn/posts",
} as const;

export interface CollectorEnvironment {
  LAUNDRY_URL?: string;
  MEALS_INCLUDE_PINNED_URL?: string;
  MEALS_DEFAULT_URL?: string;
  MEALS_PAGE_URL?: string;
  REQUEST_TIMEOUT_MS?: string;
  REQUEST_RETRIES?: string;
  USER_AGENT?: string;
  LG_RUN_STATES?: string;
}

const environmentSchema = z.object({
  LAUNDRY_URL: z.url().default(DEFAULT_COLLECTOR_URLS.laundry),
  MEALS_INCLUDE_PINNED_URL: z.url().default(DEFAULT_COLLECTOR_URLS.mealsIncludePinned),
  MEALS_DEFAULT_URL: z.url().default(DEFAULT_COLLECTOR_URLS.mealsDefault),
  MEALS_PAGE_URL: z.url().default(DEFAULT_COLLECTOR_URLS.mealsPage),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  REQUEST_RETRIES: z.coerce.number().int().nonnegative().default(2),
  USER_AGENT: z.string().trim().min(1).default("JungleBellDataCollector/1.0 (+https://github.com/si-jun-yang/jungle-bell)"),
  LG_RUN_STATES: z.string().optional(),
});

function runStates(value: string | undefined): string[] | undefined {
  if (!value?.trim()) return undefined;
  let parsed: unknown;
  try {
    parsed = value.trim().startsWith("[")
      ? JSON.parse(value) as unknown
      : value.split(",").map((item) => item.trim()).filter(Boolean);
  } catch {
    throw new Error("LG_RUN_STATES must be a JSON array or comma-separated list of strings");
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error("LG_RUN_STATES must be a JSON array or comma-separated list of strings");
  }
  return [...new Set(parsed.map((item) => item.trim().toUpperCase()).filter(Boolean))];
}

export function collectorOptionsFromEnv(environment: CollectorEnvironment): CollectorOptions {
  const parsed = environmentSchema.parse(environment);
  const lgRunStates = runStates(parsed.LG_RUN_STATES);
  return {
    urls: {
      laundry: parsed.LAUNDRY_URL,
      mealsIncludePinned: parsed.MEALS_INCLUDE_PINNED_URL,
      mealsDefault: parsed.MEALS_DEFAULT_URL,
      mealsPage: parsed.MEALS_PAGE_URL,
    },
    requestTimeoutMs: parsed.REQUEST_TIMEOUT_MS,
    requestRetries: parsed.REQUEST_RETRIES,
    userAgent: parsed.USER_AGENT,
    ...(lgRunStates ? { lgRunStates } : {}),
  };
}
