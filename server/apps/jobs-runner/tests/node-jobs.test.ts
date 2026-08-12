import { describe, expect, it, vi } from "vitest";
import { loadJobsConfiguration } from "../src/configuration/jobs-configuration";
import { runJobsCycle } from "../src/workers/jobs-cycle";

describe("OCI Jobs cycle", () => {
  it("runs collection before every lifecycle and delivers due pushes last", async () => {
    const calls: string[] = [];
    const task = (name: string) => vi.fn(async () => { calls.push(name); });
    const onError = vi.fn();

    const result = await runJobsCycle({
      collector: task("collector"),
      attendance: task("attendance"),
      meals: task("meals"),
      laundry: task("laundry"),
      housekeeping: task("housekeeping"),
      push: task("push"),
      onError,
    });

    expect(calls).toEqual(["collector", "attendance", "meals", "laundry", "housekeeping", "push"]);
    expect(result).toEqual({
      succeeded: ["collector", "attendance", "meals", "laundry", "housekeeping", "push"],
      failed: [],
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it("records one failed stage and continues later stages sequentially", async () => {
    const calls: string[] = [];
    const onError = vi.fn();

    const result = await runJobsCycle({
      collector: async () => { calls.push("collector"); throw new Error("source unavailable"); },
      attendance: async () => { calls.push("attendance"); },
      meals: async () => { calls.push("meals"); },
      laundry: async () => { calls.push("laundry"); },
      housekeeping: async () => { calls.push("housekeeping"); },
      push: async () => { calls.push("push"); },
      onError,
    });

    expect(calls).toEqual(["collector", "attendance", "meals", "laundry", "housekeeping", "push"]);
    expect(result.failed).toEqual(["collector"]);
    expect(onError).toHaveBeenCalledWith("collector", expect.objectContaining({ message: "source unavailable" }));
  });

  it("reads a fresh clock value before every lifecycle after a long collection", async () => {
    const scheduledAtEpochMs = Date.parse("2026-08-10T00:00:00.000Z");
    let nowEpochMs = scheduledAtEpochMs;
    const stageTimes: Array<[string, number]> = [];

    await runJobsCycle({
      collector: async () => {
        nowEpochMs += 6 * 60 * 60 * 1_000;
      },
      attendance: async (stageNowEpochMs) => {
        stageTimes.push(["attendance", stageNowEpochMs]);
        nowEpochMs += 1_000;
      },
      meals: async (stageNowEpochMs) => {
        stageTimes.push(["meals", stageNowEpochMs]);
        nowEpochMs += 1_000;
      },
      laundry: async (stageNowEpochMs) => {
        stageTimes.push(["laundry", stageNowEpochMs]);
        nowEpochMs += 1_000;
      },
      housekeeping: async (stageNowEpochMs) => {
        stageTimes.push(["housekeeping", stageNowEpochMs]);
        nowEpochMs += 1_000;
      },
      push: async (stageNowEpochMs) => {
        stageTimes.push(["push", stageNowEpochMs]);
      },
      onError: vi.fn(),
    }, () => nowEpochMs);

    expect(stageTimes).toEqual([
      ["attendance", scheduledAtEpochMs + 6 * 60 * 60 * 1_000],
      ["meals", scheduledAtEpochMs + 6 * 60 * 60 * 1_000 + 1_000],
      ["laundry", scheduledAtEpochMs + 6 * 60 * 60 * 1_000 + 2_000],
      ["housekeeping", scheduledAtEpochMs + 6 * 60 * 60 * 1_000 + 3_000],
      ["push", scheduledAtEpochMs + 6 * 60 * 60 * 1_000 + 4_000],
    ]);
  });
});

describe("OCI Jobs environment isolation", () => {
  const secrets = {
    JOBS_D1_GATEWAY_SECRET_FILE: "gateway",
    VAPID_PUBLIC_KEY_FILE: "vapid-public",
    VAPID_PRIVATE_KEY_FILE: "vapid-private",
    VAPID_SUBJECT: "mailto:admin@example.com",
    LAUNDRY_URL: "https://laundry.example.com/api/status",
  };
  const secretValues: Record<string, string> = {
    gateway: "g".repeat(64),
    "vapid-public": "public",
    "vapid-private": "private",
  };
  const readSecretFile = async (path: string) => `${secretValues[path] ?? ""}\n`;

  it("accepts only the fixed v2-test Worker gateway", async () => {
    await expect(loadJobsConfiguration({
      ...secrets,
      JUNGLE_BELL_ENVIRONMENT: "v2-test",
      JOBS_D1_GATEWAY_URL: "https://jungle-bell-api-test.yangsijun5528.workers.dev/internal/jobs/d1",
    }, readSecretFile)).resolves.toMatchObject({
      deployment: "v2-test",
      mealsEveryMinutes: 5,
      storage: {
        r2GatewayUrl: "https://jungle-bell-api-test.yangsijun5528.workers.dev/internal/jobs/r2",
        sharedSecret: "g".repeat(64),
      },
    });

    await expect(loadJobsConfiguration({
      ...secrets,
      JUNGLE_BELL_ENVIRONMENT: "v2-test",
      JOBS_D1_GATEWAY_URL: "https://jungle-bell-api.yangsijun5528.workers.dev/internal/jobs/d1",
    }, readSecretFile)).rejects.toThrow("v2-test D1 gateway");
  });

  it("refuses to start production jobs against the test Worker gateway", async () => {
    await expect(loadJobsConfiguration({
      ...secrets,
      JUNGLE_BELL_ENVIRONMENT: "production",
      JOBS_D1_GATEWAY_URL: "https://jungle-bell-api-test.yangsijun5528.workers.dev/internal/jobs/d1",
    }, readSecretFile)).rejects.toThrow("production D1 gateway");
  });

  it("loads OCI credentials from mounted files and trims trailing newlines", async () => {
    const fileReader = vi.fn(readSecretFile);
    const configuration = await loadJobsConfiguration({
      JUNGLE_BELL_ENVIRONMENT: "production",
      JOBS_D1_GATEWAY_URL: "https://jungle-bell-api.yangsijun5528.workers.dev/internal/jobs/d1",
      JOBS_D1_GATEWAY_SECRET_FILE: "gateway",
      VAPID_PUBLIC_KEY_FILE: "vapid-public",
      VAPID_PRIVATE_KEY_FILE: "vapid-private",
      VAPID_SUBJECT: "mailto:admin@example.com",
      LAUNDRY_URL: "https://laundry.example.com/api/status",
    }, fileReader);

    expect(configuration.d1.sharedSecret).toBe("g".repeat(64));
    expect(configuration.storage).toMatchObject({
      r2GatewayUrl: "https://jungle-bell-api.yangsijun5528.workers.dev/internal/jobs/r2",
      sharedSecret: "g".repeat(64),
    });
    expect(configuration.vapid).toMatchObject({
      publicKey: "public",
      privateKey: "private",
    });
    expect(fileReader.mock.calls.map(([path]) => path)).toEqual([
      "gateway", "vapid-public", "vapid-private",
    ]);
  });

  it("does not accept OCI secrets from inline environment values", async () => {
    await expect(loadJobsConfiguration({
      JUNGLE_BELL_ENVIRONMENT: "production",
      JOBS_D1_GATEWAY_URL: "https://jungle-bell-api.yangsijun5528.workers.dev/internal/jobs/d1",
      VAPID_SUBJECT: "mailto:admin@example.com",
      LAUNDRY_URL: "https://laundry.example.com/api/status",
      JOBS_D1_GATEWAY_SECRET: "g".repeat(64),
      VAPID_PUBLIC_KEY: "inline",
      VAPID_PRIVATE_KEY: "inline",
    } as unknown as Parameters<typeof loadJobsConfiguration>[0], readSecretFile))
      .rejects.toThrow("JOBS_D1_GATEWAY_SECRET_FILE is required");
  });

  it("applies the authenticated Worker gateway timeout and retries to D1 and R2", async () => {
    const configuration = await loadJobsConfiguration({
      ...secrets,
      JUNGLE_BELL_ENVIRONMENT: "production",
      JOBS_D1_GATEWAY_URL: "https://jungle-bell-api.yangsijun5528.workers.dev/internal/jobs/d1",
      D1_GATEWAY_TIMEOUT_MS: "12000",
      D1_GATEWAY_RETRIES: "2",
    }, readSecretFile);

    expect(configuration.d1.requestTimeoutMs).toBe(12_000);
    expect(configuration.storage).toMatchObject({
      r2RequestTimeoutMs: 12_000,
      r2RequestRetries: 2,
    });
  });
});
