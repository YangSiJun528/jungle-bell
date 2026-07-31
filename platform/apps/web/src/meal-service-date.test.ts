import { describe, expect, it } from "vitest";

import type { MealPost } from "./campus-client";
import {
  currentKstServiceDate,
  mealServiceDate,
} from "./meal-service-date";

function post(overrides: Partial<MealPost>): MealPost {
  return {
    id: "meal-1",
    kind: "DAILY_MENU",
    title: null,
    text: "menu",
    publishedAt: null,
    permalink: null,
    ...overrides,
  };
}

describe("meal service date", () => {
  it("parses Korean and separator titles in KST", () => {
    expect(
      mealServiceDate(
        post({
          title: "7월 31일(금) 중식 메뉴",
          publishedAt: "2026-07-31T01:00:00.000Z",
        }),
        "2026-08-01T01:00:00.000Z",
      ),
    ).toBe("2026-07-31");
    expect(
      mealServiceDate(
        post({ title: "2026-08-01 석식" }),
        "2026-07-31T15:10:00.000Z",
      ),
    ).toBe("2026-08-01");
  });

  it("uses the post timestamp to infer an omitted year", () => {
    expect(
      mealServiceDate(
        post({
          title: "12월 31일 석식",
          publishedAt: "2025-12-31T12:00:00.000Z",
        }),
        "2026-01-01T00:00:00.000Z",
      ),
    ).toBe("2025-12-31");
  });

  it("rejects an impossible title date and falls back to publication", () => {
    expect(
      mealServiceDate(
        post({
          title: "2월 31일 중식",
          publishedAt: "2026-02-28T03:00:00.000Z",
        }),
        "2026-03-01T00:00:00.000Z",
      ),
    ).toBe("2026-02-28");
  });

  it("computes the current service date in KST", () => {
    expect(
      currentKstServiceDate(Date.parse("2026-07-30T15:00:00.000Z")),
    ).toBe("2026-07-31");
  });
});
