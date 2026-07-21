import { describe, expect, it } from "vitest";
import { kstWeekKey } from "../src/collector/time";

describe("kstWeekKey", () => {
  it.each([
    ["2026-07-19T14:59:59.000Z", "2026-07-13"],
    ["2026-07-19T15:00:00.000Z", "2026-07-20"],
    ["2026-08-01T03:00:00.000Z", "2026-07-27"],
  ])("maps %s to Monday %s in KST", (value, expected) => {
    expect(kstWeekKey(new Date(value))).toBe(expected);
  });
});
