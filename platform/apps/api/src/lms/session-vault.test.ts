import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  AesGcmSessionSealer,
  normalizeLmsCookies,
} from "./session-vault.js";

const cookie = {
  name: "refresh_token",
  value: "header.payload.signature",
  domain: "jungle-lms.krafton.com",
  path: "/",
  expires: 1_900_000_000,
  httpOnly: true,
  secure: true,
  sameSite: "Lax" as const,
};

describe("ephemeral session utilities", () => {
  it("seals pairing transport with associated data and detects tampering", () => {
    const sealer = new AesGcmSessionSealer(randomBytes(32));
    const sealed = sealer.seal("one-time-token", "claim-1");

    expect(sealer.open(sealed, "claim-1")).toBe("one-time-token");
    expect(() => sealer.open(sealed, "claim-2")).toThrow(
      "LMS_SESSION_DECRYPTION_FAILED",
    );
  });

  it("normalizes only exact LMS cookies in memory", () => {
    expect(normalizeLmsCookies([{ ...cookie, domain: ".jungle-lms.krafton.com" }]))
      .toEqual([cookie]);
    expect(() =>
      normalizeLmsCookies([{ ...cookie, domain: ".krafton.com" }]),
    ).toThrow("LMS_COOKIE_SCOPE_INVALID");
    expect(() =>
      normalizeLmsCookies([{ ...cookie, value: "secret\r\nX-Evil: yes" }]),
    ).toThrow("LMS_COOKIE_INVALID");
  });
});
