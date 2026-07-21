import { describe, expect, it, vi } from "vitest";
import { normalizeMeals, type MealImageAsset } from "../src/collector/meals";

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

    expect(result.pinnedMenus.map((post) => post.id)).toEqual(["1"]);
    expect(result.dailyMenus.map((post) => post.id)).toEqual(["2", "3"]);
    expect(result.dailyMenus[0]?.text).toBe("밥\n국");
    expect(archive).toHaveBeenCalledWith(expect.objectContaining({
      postId: "1",
      mediaId: "11",
      sourceUrl: "https://cdn.example/menu.jpg",
    }));
  });
});
