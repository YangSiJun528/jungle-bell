import { afterEach, describe, expect, it, vi } from "vitest";
import { collectAll, collectSources } from "../src/collector/collector";
import type {
  BinaryObject,
  CollectionCommit,
  CollectorOptions,
  CollectorStorage,
  SourceName,
  SourceState,
} from "../src/collector/types";

class MemoryStorage implements CollectorStorage {
  objects = new Map<string, string | Uint8Array>();
  states = new Map<SourceName, SourceState>();
  rawWrites: string[] = [];
  committed: CollectionCommit[] = [];

  async readState(source: SourceName): Promise<SourceState | null> {
    return this.states.get(source) ?? null;
  }

  async readJson<T>(key: string): Promise<T | null> {
    const value = this.objects.get(key);
    if (typeof value !== "string") return null;
    return JSON.parse(value) as T;
  }

  async writeJson(key: string, value: unknown): Promise<void> {
    this.objects.set(key, JSON.stringify(value));
  }

  async writeRaw(key: string, value: string): Promise<void> {
    this.objects.set(key, value);
    this.rawWrites.push(key);
  }

  async objectExists(key: string): Promise<boolean> {
    return this.objects.has(key);
  }

  async writeBinary(key: string, object: BinaryObject): Promise<void> {
    this.objects.set(key, object.body);
  }

  async commit(commit: CollectionCommit): Promise<void> {
    this.committed.push(structuredClone(commit));
    this.states.set(commit.state.source, structuredClone(commit.state));
  }

  objectText(key: string): string | null {
    const value = this.objects.get(key);
    if (value === undefined) return null;
    const text = typeof value === "string" ? value : new TextDecoder().decode(value);
    return text;
  }

  json<T>(key: string): T | null {
    const value = this.objectText(key);
    return value ? JSON.parse(value) as T : null;
  }

  state(source: SourceName): SourceState | null {
    return this.states.get(source) ?? null;
  }

  commits(): CollectionCommit[] {
    return this.committed;
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
    const storage = new MemoryStorage();
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

    const first = await collectAll(storage, options, new Date("2026-07-17T00:00:30.000Z"));
    const second = await collectAll(storage, options, new Date("2026-07-17T00:01:30.000Z"));
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
    const storage = new MemoryStorage();
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

    await collectAll(storage, options, new Date("2026-07-17T00:00:00.000Z"));
    const firstKey = storage.state("laundry")?.lastNormalizedKey;
    await collectAll(storage, options, new Date("2026-07-17T00:01:00.000Z"));
    await collectAll(storage, options, new Date("2026-07-17T00:02:00.000Z"));
    const recurringKey = storage.state("laundry")?.lastNormalizedKey;

    expect(firstKey).toBeTruthy();
    expect(recurringKey).toBeTruthy();
    expect(recurringKey).not.toBe(firstKey);
    expect(storage.objects.has(firstKey ?? "")).toBe(true);
    expect(storage.objects.has(recurringKey ?? "")).toBe(true);
  });

  it("collects only requested sources while preserving source order", async () => {
    const storage = new MemoryStorage();
    const order: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      order.push(url);
      return new Response(JSON.stringify({ has_next: false, items: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const result = await collectSources(
      storage,
      options,
      ["meals-include-pinned", "meals-default"],
      new Date("2026-07-17T00:05:00.000Z"),
    );

    expect(order).toEqual([options.urls.mealsIncludePinned, options.urls.mealsDefault]);
    expect(result.results.map(({ source }) => source)).toEqual(["meals-include-pinned", "meals-default"]);
  });

  it("persists only a stable public code when an upstream error body contains sensitive text", async () => {
    const storage = new MemoryStorage();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("token=must-not-be-persisted", {
      status: 500,
    }));

    const result = await collectSources(storage, options, ["laundry"], new Date("2026-07-17T00:05:00.000Z"));
    const commit = storage.commits()[0];

    expect(result.results).toEqual([expect.objectContaining({ error: "COLLECTION_FAILED" })]);
    expect(commit?.state.lastError).toBe("COLLECTION_FAILED");
    expect(commit?.observation.error).toBe("COLLECTION_FAILED");
    expect(JSON.stringify(commit)).not.toContain("must-not-be-persisted");
  });
});
