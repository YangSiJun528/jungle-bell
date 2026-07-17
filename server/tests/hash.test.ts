import { describe, expect, it } from "vitest";
import { canonicalJsonSha256 } from "../packages/collector-core/src";

describe("canonicalJsonSha256", () => {
  it("ignores object key insertion order", async () => {
    const left = { z: 1, nested: { b: true, a: "value" } };
    const right = { nested: { a: "value", b: true }, z: 1 };

    await expect(canonicalJsonSha256(left)).resolves.toBe(await canonicalJsonSha256(right));
  });

  it("changes when an array value changes", async () => {
    await expect(canonicalJsonSha256({ values: [1, 2] })).resolves.not.toBe(
      await canonicalJsonSha256({ values: [2, 1] }),
    );
  });
});
