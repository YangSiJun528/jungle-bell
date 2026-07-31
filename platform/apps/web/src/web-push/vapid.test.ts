import { describe, expect, it } from "vitest";

import {
  base64UrlToUint8Array,
  vapidPublicKeyToApplicationServerKey,
} from "./vapid";

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

describe("base64UrlToUint8Array", () => {
  it("decodes URL-safe base64 with omitted padding", () => {
    expect([...base64UrlToUint8Array("SGVsbG8td29ybGQ")]).toEqual([
      72, 101, 108, 108, 111, 45, 119, 111, 114, 108, 100,
    ]);
  });

  it.each(["a", "abc$", "ab=c", ""])(
    "rejects malformed base64url input: %s",
    (value) => {
      expect(() => base64UrlToUint8Array(value)).toThrow();
    },
  );
});

describe("vapidPublicKeyToApplicationServerKey", () => {
  it("accepts an uncompressed P-256 public key", () => {
    const bytes = new Uint8Array(65);
    bytes[0] = 4;
    bytes.fill(7, 1);

    expect([
      ...vapidPublicKeyToApplicationServerKey(toBase64Url(bytes)),
    ]).toEqual([...bytes]);
  });

  it("rejects keys with an invalid length or point prefix", () => {
    const tooShort = new Uint8Array(64);
    tooShort[0] = 4;
    const compressed = new Uint8Array(65);
    compressed[0] = 2;

    expect(() =>
      vapidPublicKeyToApplicationServerKey(toBase64Url(tooShort)),
    ).toThrow();
    expect(() =>
      vapidPublicKeyToApplicationServerKey(toBase64Url(compressed)),
    ).toThrow();
  });
});
