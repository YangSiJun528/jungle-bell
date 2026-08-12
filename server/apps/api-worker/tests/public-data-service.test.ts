import { describe, expect, it } from "vitest";
import type { MealsVersion } from "../../../shared/collection/meals";
import type { SourceState } from "../../../shared/collection/types";
import {
  PublicDataService,
  type PublicDataStorage,
} from "../src/services/public-data-service";

function storageStub(overrides: Partial<PublicDataStorage> = {}): PublicDataStorage {
  return {
    readAllStates: async () => [],
    readState: async () => null,
    readJson: async <T>() => null as T | null,
    readObservation: async () => null,
    listLaundryEvents: async () => [],
    listMealPosts: async () => [],
    listWeeklyMealMenus: async () => [],
    readObject: async () => null,
    ...overrides,
  };
}

describe("PublicDataService", () => {
  it("uses its injected clock when creating cache metadata", async () => {
    const clock = {
      now: () => new Date("2026-07-19T03:00:17.000Z"),
    };

    const result = await new PublicDataService(storageStub(), clock).status();

    expect(result).toEqual({
      asOf: "2026-07-19T03:00:00.000Z",
      sources: [],
    });
  });

  it("selects the current KST meal week from the same injected time", async () => {
    const observedAt = "2026-07-19T02:00:00.000Z";
    const version: MealsVersion = {
      schemaVersion: 2,
      sourceVersionSha: "a".repeat(64),
      observedAt,
      hasNext: false,
      pinnedMenus: [{
        id: "weekly",
        kind: "PINNED_MENU",
        contentSha: "b".repeat(64),
        title: "7월 3주차 식단표",
        text: "",
        pinned: true,
        publishedAt: null,
        updatedAt: observedAt,
        permalink: null,
        status: "published",
        images: [],
      }],
      dailyMenus: [],
      otherPosts: [],
    };
    const sourceState: SourceState = {
      source: "meals-include-pinned",
      lastAttemptAt: observedAt,
      lastSuccessAt: observedAt,
      lastResponseSha: version.sourceVersionSha,
      lastRawKey: null,
      lastNormalizedKey: "versions/meals.json",
      versionFirstSeenAt: observedAt,
      consecutiveFailures: 0,
      lastError: null,
    };
    const storage = storageStub({
      readState: async () => sourceState,
      readJson: async <T>(key: string) => key === "versions/meals.json" ? version as T : null,
    });
    const service = new PublicDataService(storage, {
      now: () => new Date("2026-07-19T03:00:17.000Z"),
    });

    const result = await service.meals("https://api.test/api/public/meals");

    expect(result).toMatchObject({
      ok: true,
      value: {
        asOf: "2026-07-19T03:00:00.000Z",
        data: {
          currentWeeklyMenu: {
            targetWeekKey: "2026-07-20",
            status: "AVAILABLE",
            post: { title: "7월 3주차 식단표" },
          },
        },
      },
    });
  });
});
