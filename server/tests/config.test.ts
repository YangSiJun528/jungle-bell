import { describe, expect, it } from "vitest";
import { collectorOptionsFromEnv, DEFAULT_COLLECTOR_URLS } from "../src/config";

describe("collectorOptionsFromEnv", () => {
  it("applies validated defaults", () => {
    const options = collectorOptionsFromEnv({});

    expect(options.urls).toEqual({
      laundry: DEFAULT_COLLECTOR_URLS.laundry,
      mealsIncludePinned: DEFAULT_COLLECTOR_URLS.mealsIncludePinned,
      mealsDefault: DEFAULT_COLLECTOR_URLS.mealsDefault,
      mealsPage: DEFAULT_COLLECTOR_URLS.mealsPage,
    });
    expect(options.requestTimeoutMs).toBe(30_000);
    expect(options.requestRetries).toBe(2);
  });

  it("normalizes comma-separated and JSON LG run states", () => {
    expect(collectorOptionsFromEnv({ LG_RUN_STATES: "running, END, running" }).lgRunStates)
      .toEqual(["RUNNING", "END"]);
    expect(collectorOptionsFromEnv({ LG_RUN_STATES: '["power_off", "error"]' }).lgRunStates)
      .toEqual(["POWER_OFF", "ERROR"]);
  });

  it("rejects invalid URLs and numeric settings", () => {
    expect(() => collectorOptionsFromEnv({ LAUNDRY_URL: "not-a-url" })).toThrow();
    expect(() => collectorOptionsFromEnv({ REQUEST_TIMEOUT_MS: "0" })).toThrow();
    expect(() => collectorOptionsFromEnv({ REQUEST_RETRIES: "1.5" })).toThrow();
  });

  it("rejects malformed LG run states", () => {
    expect(() => collectorOptionsFromEnv({ LG_RUN_STATES: '["RUNNING", 1]' })).toThrow(
      "LG_RUN_STATES must be a JSON array or comma-separated list of strings",
    );
  });
});
