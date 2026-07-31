import { describe, expect, it } from "vitest";

import {
  laundryResponseSchema,
  mealsResponseSchema,
} from "./contracts.js";
import {
  detectLaundryTransitionEvents,
  detectMealPublishedEvents,
} from "./events.js";
import { laundryFixture, mealsFixture } from "./test-fixtures.js";

describe("campus event detection", () => {
  it("uses the first meal snapshot as a baseline and detects a changed daily menu", () => {
    const previous = mealsResponseSchema.parse({
      ...mealsFixture(),
      data: {
        ...mealsFixture().data,
        dailyMenus: [mealPost("post-1", "old")],
      },
    });
    const current = mealsResponseSchema.parse({
      ...mealsFixture(),
      data: {
        ...mealsFixture().data,
        dailyMenus: [mealPost("post-1", "new")],
      },
    });

    expect(
      detectMealPublishedEvents(null, current, 1_000),
    ).toEqual([]);
    expect(
      detectMealPublishedEvents(previous, current, 1_000),
    ).toMatchObject([
      {
        kind: "meal-published",
        meal: "lunch",
        serviceDate: "2026-07-31",
        contentSha: "new",
      },
    ]);
  });

  it("extracts a Korean service date and infers its year from publication", () => {
    const previous = mealsResponseSchema.parse({
      ...mealsFixture(),
      data: {
        ...mealsFixture().data,
        dailyMenus: [],
      },
    });
    const current = mealsResponseSchema.parse({
      ...mealsFixture(),
      data: {
        ...mealsFixture().data,
        dailyMenus: [
          {
            ...mealPost("post-korean", "korean"),
            title: "12월 31일 중식 메뉴",
            publishedAt: "2025-12-31T02:00:00.000Z",
            updatedAt: "2025-12-31T02:00:00.000Z",
          },
        ],
      },
    });

    expect(
      detectMealPublishedEvents(previous, current, 1_000),
    ).toMatchObject([
      {
        kind: "meal-published",
        serviceDate: "2025-12-31",
      },
    ]);
  });

  it("normalizes an appliance transition and countdown observation", () => {
    const previous = laundryResponseSchema.parse({
      ...laundryFixture(),
      machines: [
        {
          id: "tower-3",
          washer: appliance("RUNNING", 20, "session-1"),
          dryer: null,
        },
      ],
    });
    const current = laundryResponseSchema.parse({
      ...laundryFixture(),
      machines: [
        {
          id: "tower-3",
          washer: appliance("RUNNING", 10, "session-1"),
          dryer: null,
        },
      ],
    });

    expect(
      detectLaundryTransitionEvents(previous, current, 2_000),
    ).toMatchObject([
      {
        kind: "laundry-transition",
        machineId: "tower-3",
        appliance: "washer",
        previousState: "BUSY",
        currentState: "BUSY",
        remainingMinutes: 10,
      },
    ]);
  });
});

function mealPost(id: string, contentSha: string) {
  return {
    id,
    kind: "DAILY_MENU",
    contentSha,
    title: "2026-07-31 중식 메뉴",
    text: "김치찌개",
    pinned: false,
    publishedAt: "2026-07-31T02:00:00.000Z",
    updatedAt: "2026-07-31T02:00:00.000Z",
    permalink: null,
    status: null,
    images: [],
  };
}

function appliance(
  operationalStatus: "RUNNING",
  remainingMinutes: number,
  sessionId: string,
) {
  return {
    machineId: "tower-3",
    appliance: "washer",
    observedAt: "2026-07-31T00:00:00.000Z",
    state: { code: "RUN", raw: "RUN", known: true },
    operationalStatus,
    remainingMinutes,
    totalMinutes: 60,
    startedAt: "2026-07-30T23:20:00.000Z",
    estimatedFinishAt: "2026-07-31T00:10:00.000Z",
    remoteControlEnabled: false,
    cycleCount: 1,
    sessionId,
    errorCode: null,
    projection: {
      asOf: "2026-07-31T00:00:00.000Z",
      remainingMinutes,
      status: "ESTIMATED_RUNNING",
      estimated: true,
    },
  };
}
