import { describe, expect, it } from "vitest";
import {
  decodeMealHistoryCursor,
  encodeMealHistoryCursor,
} from "../src/domain/meal-history";

describe("meal history cursor", () => {
  it("round-trips a canonical timestamp and an encoded post id", () => {
    const value = encodeMealHistoryCursor({
      id: "meal/한글 30",
      publishedAt: "2026-08-10T02:07:38.000Z",
      firstSeenAt: "2026-08-10T02:08:00.000Z",
    });

    expect(value).toBe("2026-08-10T02:07:38.000Z~meal%2F%ED%95%9C%EA%B8%80%2030");
    expect(decodeMealHistoryCursor(value)).toEqual({
      timestamp: "2026-08-10T02:07:38.000Z",
      postId: "meal/한글 30",
    });
  });

  it("rejects timestamp-only, malformed, and non-canonical cursors", () => {
    for (const value of [
      "2026-08-10T02:07:38.000Z",
      "2026-08-10T02:07:38Z~meal-30",
      "2026-08-10T02:07:38.000Z~",
      "2026-08-10T02:07:38.000Z~meal%2f30",
      "2026-08-10T02:07:38.000Z~meal%ZZ30",
    ]) {
      expect(decodeMealHistoryCursor(value)).toBeNull();
    }
  });
});
