import { describe, expect, it } from "vitest";
import { rasterImageContentType } from "../src/collector/media";

describe("meal media validation", () => {
  it.each([
    ["jpeg", [0xff, 0xd8, 0xff, 0x00], "image/jpeg"],
    ["png", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "image/png"],
    ["gif", [...Buffer.from("GIF89a")], "image/gif"],
    ["webp", [...Buffer.from("RIFF0000WEBP")], "image/webp"],
    ["avif", [0, 0, 0, 24, ...Buffer.from("ftypavif")], "image/avif"],
  ])("recognizes %s by its file signature", (_name, bytes, expected) => {
    expect(rasterImageContentType(new Uint8Array(bytes as number[]))).toBe(expected);
  });

  it("rejects SVG and arbitrary bytes even when an upstream labels them as images", () => {
    expect(rasterImageContentType(new TextEncoder().encode("<svg><script/></svg>"))).toBeNull();
    expect(rasterImageContentType(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});
