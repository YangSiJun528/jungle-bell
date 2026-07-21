import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectAll,
  type BinaryObject,
  type CollectionCommit,
  type CollectorOptions,
  type CollectorStorage,
  type SourceName,
  type SourceState,
} from "../packages/collector-core/src";

class MemoryStorage implements CollectorStorage {
  states = new Map<SourceName, SourceState>();
  objects = new Map<string, unknown>();
  rawWrites: string[] = [];
  commits: CollectionCommit[] = [];

  async readState(source: SourceName): Promise<SourceState | null> {
    return this.states.get(source) ?? null;
  }

  async readJson<T>(key: string): Promise<T | null> {
    return this.objects.get(key) as T ?? null;
  }

  async writeJson(key: string, value: unknown): Promise<void> {
    this.objects.set(key, structuredClone(value));
  }

  async writeRaw(key: string, raw: string): Promise<void> {
    this.rawWrites.push(key);
    this.objects.set(key, raw);
  }

  async objectExists(key: string): Promise<boolean> {
    return this.objects.has(key);
  }

  async writeBinary(key: string, object: BinaryObject): Promise<void> {
    this.objects.set(key, object);
  }

  async commit(commit: CollectionCommit): Promise<void> {
    this.commits.push(structuredClone(commit));
    this.states.set(commit.state.source, structuredClone(commit.state));
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
      const value = url.includes("laundry") ? laundry() : { has_next: false, items: [] };
      return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    const first = await collectAll(storage, options, new Date("2026-07-17T00:00:30.000Z"));
    const second = await collectAll(storage, options, new Date("2026-07-17T00:01:30.000Z"));

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
    expect(storage.commits).toHaveLength(6);
    expect(storage.commits.slice(3).map((commit) => commit.observation.changed)).toEqual([false, false, false]);
    expect(storage.commits.slice(3).map((commit) => commit.observation.minuteEpoch)).toEqual([
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
    const firstKey = storage.states.get("laundry")?.lastNormalizedKey;
    await collectAll(storage, options, new Date("2026-07-17T00:01:00.000Z"));
    await collectAll(storage, options, new Date("2026-07-17T00:02:00.000Z"));
    const recurringKey = storage.states.get("laundry")?.lastNormalizedKey;

    expect(firstKey).toBeTruthy();
    expect(recurringKey).toBeTruthy();
    expect(recurringKey).not.toBe(firstKey);
    expect(storage.objects.has(firstKey ?? "")).toBe(true);
    expect(storage.objects.has(recurringKey ?? "")).toBe(true);
  });
});
