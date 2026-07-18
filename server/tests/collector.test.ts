import { afterEach, describe, expect, it, vi } from "vitest";
import { collectAll } from "../src/collector/collector";
import type { CollectionCommit, CollectorOptions, SourceName, SourceState } from "../src/collector/types";

class MemoryBucket {
  readonly bucket = this as unknown as R2Bucket;
  objects = new Map<string, string | Uint8Array>();
  rawWrites: string[] = [];

  async put(key: string, value: string | Uint8Array): Promise<object> {
    this.objects.set(key, value);
    if (key.startsWith("raw/") || key.startsWith("latest/raw/")) this.rawWrites.push(key);
    return {};
  }

  async get(key: string): Promise<object | null> {
    const value = this.objects.get(key);
    if (value === undefined) return null;
    return {
      text: async () => typeof value === "string" ? value : new TextDecoder().decode(value),
    };
  }

  async head(key: string): Promise<object | null> {
    return this.objects.has(key) ? {} : null;
  }

  json<T>(key: string): T | null {
    const value = this.objects.get(key);
    return typeof value === "string" ? JSON.parse(value) as T : null;
  }

  state(source: SourceName): SourceState | null {
    return this.json<SourceState>(`collector/state/${source}.json`);
  }

  commits(): CollectionCommit[] {
    return [...this.objects]
      .filter(([key]) => key.startsWith("collector/commits/"))
      .map(([, value]) => JSON.parse(value as string) as CollectionCommit);
  }
}

const options: CollectorOptions = {
  urls: {
    laundry: "https://source.test/laundry",
    mealsIncludePinned: "https://source.test/meals?pinned=true",
    mealsDefault: "https://source.test/meals",
    mealsPage: "https://source.test/page",
  },
  requestTimeoutMs: 1_000,
  requestRetries: 0,
  userAgent: "test",
};

function laundry(state = "POWER_OFF"): unknown {
  return {
    tower: {
      washer: {
        runState: { currentState: state },
        timer: { remainHour: 0, remainMinute: 0, totalHour: 0, totalMinute: 0 },
      },
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe("collectAll", () => {
  it("requests sources sequentially and only stores new JSON versions", async () => {
    const storage = new MemoryBucket();
    const order: string[] = [];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      order.push(url);
      const value = url.includes("laundry")
        ? laundry()
        : url.includes("pinned=true")
          ? {
              has_next: false,
              items: [{
                id: 10,
                pinned: false,
                title: "7월 17일 중식 메뉴",
                contents: [{ t: "text", v: "밥\n국" }],
                media: [],
              }],
            }
          : { has_next: false, items: [] };
      return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    const first = await collectAll(storage.bucket, options, new Date("2026-07-17T00:00:30.000Z"));
    const second = await collectAll(storage.bucket, options, new Date("2026-07-17T00:01:30.000Z"));
    const commits = storage.commits();

    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(order).toEqual([
      options.urls.laundry,
      options.urls.mealsIncludePinned,
      options.urls.mealsDefault,
      options.urls.laundry,
      options.urls.mealsIncludePinned,
      options.urls.mealsDefault,
    ]);
    expect(first.results.every((result) => result.changed)).toBe(true);
    expect(second.results.every((result) => !result.changed)).toBe(true);
    expect(storage.rawWrites).toHaveLength(6);
    expect(commits).toHaveLength(6);
    expect(commits.find((commit) => commit.state.source === "meals-include-pinned")?.mealPosts)
      .toEqual([expect.objectContaining({ id: "10", text: "밥\n국" })]);
    expect(commits.slice(3).map((commit) => commit.observation.changed)).toEqual([false, false, false]);
    expect(commits.slice(3).map((commit) => commit.observation.minuteEpoch)).toEqual([
      Date.parse("2026-07-17T00:01:00.000Z") / 60_000,
      Date.parse("2026-07-17T00:01:00.000Z") / 60_000,
      Date.parse("2026-07-17T00:01:00.000Z") / 60_000,
    ]);
  });

  it("does not overwrite an earlier normalized occurrence when a raw SHA returns", async () => {
    const storage = new MemoryBucket();
    let call = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const run = Math.floor(call / 3);
      call += 1;
      const url = input instanceof Request ? input.url : String(input);
      const stateByRun = ["POWER_OFF", "RUNNING", "POWER_OFF"];
      const value = url.includes("laundry")
        ? laundry(stateByRun[run])
        : { has_next: false, items: [] };
      return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    await collectAll(storage.bucket, options, new Date("2026-07-17T00:00:00.000Z"));
    const firstKey = storage.state("laundry")?.lastNormalizedKey;
    await collectAll(storage.bucket, options, new Date("2026-07-17T00:01:00.000Z"));
    await collectAll(storage.bucket, options, new Date("2026-07-17T00:02:00.000Z"));
    const recurringKey = storage.state("laundry")?.lastNormalizedKey;

    expect(firstKey).toBeTruthy();
    expect(recurringKey).toBeTruthy();
    expect(recurringKey).not.toBe(firstKey);
    expect(storage.objects.has(firstKey ?? "")).toBe(true);
    expect(storage.objects.has(recurringKey ?? "")).toBe(true);
  });
});
