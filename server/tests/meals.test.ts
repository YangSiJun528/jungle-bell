import { describe, expect, it, vi } from "vitest";
import {
  currentWeeklyMealMenu,
  mealPostContentSha,
  normalizeMeals,
  sourceMealWeekKey,
  targetMealWeekKey,
  weeklyMealMenu,
  type MealImageAsset,
} from "../src/collector/meals";

describe("normalizeMeals", () => {
  it("keeps pinned and daily posts separate and delegates image storage", async () => {
    const archive = vi.fn(async (candidate): Promise<MealImageAsset> => ({
      ...candidate,
      sha: "f".repeat(64),
      objectKey: `assets/ff/${"f".repeat(64)}.jpg`,
      contentType: "image/jpeg",
      extension: "jpg",
      byteLength: 123,
    }));
    const value = {
      has_next: false,
      items: [
        {
          id: 1,
          pinned: true,
          title: "7월 3주차 식단표",
          contents: [],
          media: [{ id: 11, type: "image", xlarge_url: "http://cdn.example/menu.jpg", mimetype: "image/jpeg" }],
        },
        {
          id: 2,
          pinned: false,
          title: "7월 17일 중식 메뉴",
          contents: [{ t: "text", v: "밥\n국" }],
          media: [],
        },
        {
          id: 3,
          pinned: false,
          title: "7월 10일 중식 메누",
          contents: [],
          media: [],
        },
      ],
    };

    const result = await normalizeMeals(value, "a".repeat(64), "2026-07-17T00:00:00.000Z", archive);

    expect(result.schemaVersion).toBe(2);
    expect(result.pinnedMenus.map((post) => post.id)).toEqual(["1"]);
    expect(result.pinnedMenus[0]?.contentSha).toMatch(/^[a-f0-9]{64}$/);
    expect(result.dailyMenus.map((post) => post.id)).toEqual(["2", "3"]);
    expect(result.dailyMenus[0]?.text).toBe("밥\n국");
    expect(archive).toHaveBeenCalledWith(expect.objectContaining({
      postId: "1",
      mediaId: "11",
      sourceUrl: "https://cdn.example/menu.jpg",
    }));
  });

  it("hashes meal content independently from post and CDN metadata", async () => {
    const post = {
      title: "7월 3주차 식단표",
      text: "주간 식단",
      images: [{ sha: "a".repeat(64) }],
    } as Parameters<typeof mealPostContentSha>[0];

    const first = await mealPostContentSha(post);
    const sameContent = await mealPostContentSha({
      ...post,
      images: [{ ...post.images[0]!, sourceUrl: "https://other.example/menu.jpg" }],
    });
    const changedImage = await mealPostContentSha({
      ...post,
      images: [{ ...post.images[0]!, sha: "b".repeat(64) }],
    });

    expect(sameContent).toBe(first);
    expect(changedImage).not.toBe(first);
  });

  it("maps provider week titles from the first Monday in the named month", () => {
    const reference = new Date("2026-07-13T01:00:00.000Z");

    expect(sourceMealWeekKey("7월 2주차 식단표", reference)).toBe("2026-07-13");
    expect(sourceMealWeekKey("2026년 7월 3주차 식단표", reference)).toBe("2026-07-20");
    expect(sourceMealWeekKey("이번 주 식단표", reference)).toBeNull();
  });

  it("uses the upcoming Monday as the target meal week on Sunday", () => {
    expect(targetMealWeekKey(new Date("2026-07-19T03:00:00.000Z"))).toBe("2026-07-20");
    expect(targetMealWeekKey(new Date("2026-07-20T03:00:00.000Z"))).toBe("2026-07-20");
    expect(targetMealWeekKey(new Date("2026-07-18T03:00:00.000Z"))).toBe("2026-07-13");
  });

  it("exposes a pinned menu only when its title matches the target week", async () => {
    const archive = async (candidate: Parameters<typeof normalizeMeals>[3] extends (value: infer T) => unknown ? T : never) => ({
      ...candidate,
      sha: "f".repeat(64),
      objectKey: `assets/ff/${"f".repeat(64)}.jpg`,
      contentType: "image/jpeg",
      extension: "jpg",
      byteLength: 123,
    });
    const normalizePinned = async (title: string) => (await normalizeMeals({
      has_next: false,
      items: [{ id: 1, pinned: true, title, contents: [], media: [] }],
    }, "a".repeat(64), "2026-07-19T03:00:00.000Z", archive)).pinnedMenus[0]!;
    const previous = await weeklyMealMenu(await normalizePinned("7월 2주차 식단표"), "2026-07-19T03:00:00.000Z");
    const next = await weeklyMealMenu(await normalizePinned("7월 3주차 식단표"), "2026-07-19T03:00:00.000Z");

    expect(currentWeeklyMealMenu([previous!], new Date("2026-07-19T03:00:00.000Z")))
      .toMatchObject({ status: "AWAITING_UPDATE", targetWeekKey: "2026-07-20", post: null });
    expect(currentWeeklyMealMenu([next!], new Date("2026-07-19T03:00:00.000Z")))
      .toMatchObject({ status: "AVAILABLE", targetWeekKey: "2026-07-20", post: { title: "7월 3주차 식단표" } });
  });
});
