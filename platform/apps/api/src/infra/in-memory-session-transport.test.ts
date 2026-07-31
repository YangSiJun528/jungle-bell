import { describe, expect, it } from "vitest";

import { InMemoryDesktopSessionStore } from "./in-memory-session-transport.js";

describe("InMemoryDesktopSessionStore", () => {
  it("matches the atomic desktop session rotation contract", async () => {
    const sessions = new InMemoryDesktopSessionStore();
    const first = session("first-token", "desktop-a", 1_000);
    const otherDevice = session("other-device-token", "desktop-b", 1_000);

    expect(await sessions.insertReplacingActive(first)).toBe(true);
    expect(await sessions.insertReplacingActive(otherDevice)).toBe(true);
    expect(
      await sessions.insertReplacingActive(
        session("replacement-token", "desktop-a", 2_000),
      ),
    ).toBe(true);
    expect(await sessions.findByTokenHash(first.tokenHash)).toMatchObject({
      revokedAtEpochMs: 2_000,
      version: 1,
    });
    expect(
      await sessions.findByTokenHash(otherDevice.tokenHash),
    ).toMatchObject({
      revokedAtEpochMs: null,
      version: 0,
    });

    expect(
      await sessions.insertReplacingActive(
        session(otherDevice.tokenHash, "desktop-a", 3_000),
      ),
    ).toBe(false);
    expect(
      await sessions.findByTokenHash("replacement-token"),
    ).toMatchObject({
      revokedAtEpochMs: null,
      version: 0,
    });
  });
});

function session(
  tokenHash: string,
  desktopDeviceId: string,
  createdAtEpochMs: number,
) {
  return {
    tokenHash,
    userId: "user-1",
    desktopDeviceId,
    createdAtEpochMs,
    expiresAtEpochMs: createdAtEpochMs + 10_000,
    revokedAtEpochMs: null,
    version: 0,
  };
}
