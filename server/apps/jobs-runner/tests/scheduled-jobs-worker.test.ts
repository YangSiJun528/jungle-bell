import { beforeEach, describe, expect, it, vi } from "vitest";

const collaborators = vi.hoisted(() => ({
  collectSources: vi.fn(),
  writeJson: vi.fn(),
  runHousekeeping: vi.fn(),
}));

vi.mock("@logtape/logtape", () => ({
  getLogger: () => ({ error: vi.fn(), info: vi.fn() }),
}));
vi.mock("@jungle-bell/backend-common/renewal/push-sender", () => ({
  deliverDuePushes: vi.fn(async () => undefined),
}));
vi.mock("../src/clients/web-push-sender", () => ({
  NodeWebPushSender: class {},
}));
vi.mock("../src/configuration/jobs-configuration", () => ({
  loadJobsConfiguration: vi.fn(async () => ({
    deployment: "test",
    mealsEveryMinutes: 5,
    collector: {},
    vapid: {},
  })),
}));
vi.mock("../src/services/attendance-notification-service", () => ({
  planAttendanceNotifications: vi.fn(async () => undefined),
}));
vi.mock("../src/services/laundry-lifecycle-service", () => ({
  runLaundryLifecycle: vi.fn(async () => undefined),
}));
vi.mock("../src/services/meal-publication-service", () => ({
  runMealPublicationLifecycle: vi.fn(async () => undefined),
}));
vi.mock("../src/services/source-collection-service", () => ({
  collectSources: collaborators.collectSources,
}));
vi.mock("../src/storage/jobs-storage", () => ({
  createJobsStorage: () => ({
    collector: { writeJson: collaborators.writeJson },
    renewal: { runHousekeeping: collaborators.runHousekeeping },
  }),
}));

import { executeJobs } from "../src/workers/scheduled-jobs-worker";

describe("scheduled jobs worker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    collaborators.collectSources.mockResolvedValue({
      scheduledAt: "2026-08-10T00:00:00.000Z",
      results: [],
    });
    collaborators.runHousekeeping.mockResolvedValue(undefined);
    collaborators.writeJson.mockResolvedValue(undefined);
  });

  it("passes its injected clock to source collection", async () => {
    const baseEpochMs = Date.parse("2026-08-10T00:00:00.000Z");
    let tick = 0;
    const clock = () => baseEpochMs + tick++ * 1_000;
    let collectionNowEpochMs: number | null = null;
    collaborators.collectSources.mockImplementation(async (...args: unknown[]) => {
      const collectionClock = args[4] as (() => Date) | undefined;
      collectionNowEpochMs = collectionClock?.().getTime() ?? null;
      return { scheduledAt: new Date(baseEpochMs).toISOString(), results: [] };
    });

    await executeJobs({}, new Date(baseEpochMs), clock);

    expect(collectionNowEpochMs).toBe(baseEpochMs + 1_000);
  });
});
