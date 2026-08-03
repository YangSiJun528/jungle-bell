import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getPublicLaundry,
  getPublicMeals,
  type CampusEnvelope,
  type LaundrySnapshot,
  type MealsSnapshot,
} from "./campus-client";

const fetchMock = vi.fn();

const laundry: LaundrySnapshot = {
  asOf: "2026-07-31T04:33:30.000Z",
  final: false,
  quality: {
    collection: "SUCCESS",
    sourceFreshness: "WITHIN_REFRESH_WINDOW",
    lastCheckedAt: "2026-07-31T04:33:00.752Z",
  },
  machines: [
    {
      id: "워시타워_1",
      washer: {
        appliance: "washer",
        operationalStatus: "IDLE",
        remainingMinutes: 0,
        sessionId: "washer-session",
        projection: {
          remainingMinutes: 0,
          status: "IDLE",
          estimated: false,
        },
      },
      dryer: {
        appliance: "dryer",
        operationalStatus: "RUNNING",
        remainingMinutes: 18,
        sessionId: "dryer-session",
        projection: {
          remainingMinutes: 15,
          status: "ESTIMATED_RUNNING",
          estimated: true,
        },
      },
    },
  ],
};

const meals: MealsSnapshot = {
  asOf: "2026-07-31T04:33:30.000Z",
  lastCheckedAt: "2026-07-31T04:30:13.220Z",
  data: {
    dailyMenus: [
      {
        id: "114130545",
        kind: "DAILY_MENU",
        title: "7월 31일(금) 중식 메뉴",
        text: "살얼음오징어물회, 추가밥, 돼지고기육전",
        publishedAt: "2026-07-31T02:32:56.000Z",
        permalink: "http://pf.kakao.com/_xhzNjn/114130545",
      },
    ],
    pinnedMenus: [],
    recentMenus: [],
  },
};

describe("public campus API client", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads validated real laundry and meal snapshots from same-origin routes", async () => {
    respondJson(envelope("laundry", laundry));
    respondJson(envelope("meals", meals));

    await expect(getPublicLaundry()).resolves.toEqual(
      envelope("laundry", laundry),
    );
    await expect(getPublicMeals()).resolves.toEqual(envelope("meals", meals));

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/public/campus/laundry",
      expect.objectContaining({
        credentials: "include",
        headers: { accept: "application/json" },
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/public/campus/meals",
      expect.objectContaining({
        credentials: "include",
        headers: { accept: "application/json" },
      }),
    );
  });

  it("accepts an empty last-good envelope and preserves its error state", async () => {
    const unavailable: CampusEnvelope<LaundrySnapshot> = {
      kind: "laundry",
      data: null,
      etag: null,
      savedAtEpochMs: null,
      lastCheckedAtEpochMs: 1_775_000_000_000,
      stale: true,
      lastError: "UPSTREAM_TIMEOUT",
    };
    respondJson(unavailable);

    await expect(getPublicLaundry()).resolves.toEqual(unavailable);
  });

  it("accepts a meal snapshot that has never been checked", async () => {
    const uncheckedMeals: MealsSnapshot = {
      ...meals,
      lastCheckedAt: null,
    };
    respondJson(envelope("meals", uncheckedMeals));

    await expect(getPublicMeals()).resolves.toEqual(
      envelope("meals", uncheckedMeals),
    );
  });

  it.each([
    {
      name: "an unexpected envelope field",
      value: { ...envelope("laundry", laundry), accessToken: "secret" },
    },
    {
      name: "a mismatched resource kind",
      value: envelope("meals", laundry),
    },
    {
      name: "an invalid machine appliance",
      value: envelope("laundry", {
        ...laundry,
        machines: [
          {
            ...laundry.machines[0],
            washer: {
              ...laundry.machines[0]!.washer,
              appliance: "oven",
            },
          },
        ],
      }),
    },
  ])("rejects $name", async ({ value }) => {
    respondJson(value);

    await expect(getPublicLaundry()).rejects.toThrow(
      "API_RESPONSE_INVALID",
    );
  });

  it("rejects an unsafe meal permalink", async () => {
    respondJson(
      envelope("meals", {
        ...meals,
        data: {
          ...meals.data,
          dailyMenus: [
            {
              ...meals.data.dailyMenus[0]!,
              permalink: "javascript:alert(1)",
            },
          ],
        },
      }),
    );

    await expect(getPublicMeals()).rejects.toThrow(
      "API_RESPONSE_INVALID",
    );
  });
});

function envelope<T>(
  kind: "laundry" | "meals",
  data: T,
): CampusEnvelope<T> {
  return {
    kind,
    data,
    etag: "\"campus-etag\"",
    savedAtEpochMs: 1_775_000_000_000,
    lastCheckedAtEpochMs: 1_775_000_001_000,
    stale: false,
    lastError: null,
  };
}

function respondJson(body: unknown, status = 200): void {
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}
