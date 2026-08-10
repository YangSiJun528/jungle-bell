import { describe, expect, it, vi } from "vitest";
import { normalizeManualPairingCode, randomManualPairingCode, sha256Hex } from "../src/renewal/crypto";
import { attendanceReminderWindowAt } from "../src/renewal/attendance-policy";
import { HttpLmsIdentityGateway } from "../src/renewal/lms-gateway";

describe("renewal security primitives", () => {
  it("uses the LMS immutable ID SHA-256 as the cross-installation identity", async () => {
    expect(await sha256Hex("12345")).toBe("5994471abb01112afcc18159f6cc74b4f511b99806da59b3caf5a9c173cacfc5");
  });

  it("verifies the LMS subject with one cookie on the canonical /api/v2/me endpoint", async () => {
    const fetcher = vi.fn(async () => new Response('{"id":42}', {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const gateway = new HttpLmsIdentityGateway(fetcher as typeof fetch);
    await expect(gateway.verifyIdentity([{
      name: "access_token", value: "one-shot", domain: "jungle-lms.krafton.com", path: "/",
      expires: -1, httpOnly: true, secure: true, sameSite: "Strict",
    }])).resolves.toEqual({ authenticated: true, subject: "42" });
    expect(fetcher).toHaveBeenCalledWith("https://jungle-lms.krafton.com/api/v2/me", expect.objectContaining({
      redirect: "manual",
      headers: expect.objectContaining({ cookie: "access_token=one-shot" }),
    }));
    expect(fetcher.mock.contexts[0]).toBeUndefined();
  });

  it("creates and normalizes an exact ten-character Crockford code", () => {
    const code = randomManualPairingCode();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{10}$/);
    expect(normalizeManualPairingCode("0o1i-l abcde")).toBe("00111ABCDE");
    expect(normalizeManualPairingCode("too-short")).toBeNull();
  });
});

describe("attendance reminder windows", () => {
  it.each([
    ["2026-08-03T00:50:00.000Z", "2026-08-03", "morning", "before-10"],
    ["2026-08-03T01:00:00.000Z", "2026-08-03", "morning", "deadline"],
    ["2026-08-03T18:50:00.000Z", "2026-08-03", "evening", "before-10"],
    ["2026-08-03T19:00:00.000Z", "2026-08-03", "evening", "deadline"],
  ])("maps %s into a deduplicated KST attendance slot", (time, attendanceDate, phase, slot) => {
    expect(attendanceReminderWindowAt(Date.parse(time))).toMatchObject({ attendanceDate, phase, slot });
  });

  it("does not plan outside a ten-minute reminder window", () => {
    expect(attendanceReminderWindowAt(Date.parse("2026-08-03T00:49:59.000Z"))).toBeNull();
  });
});
