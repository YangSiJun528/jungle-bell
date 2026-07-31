import { describe, expect, it } from "vitest";

import { resolveSurface } from "./surface";

describe("resolveSurface", () => {
  it("keeps the public web unauthenticated and read-only", () => {
    expect(resolveSurface("/", false)).toEqual({
      kind: "public",
      canManageLmsSession: false,
      canPair: false,
      canReceivePersonalNotifications: false,
      canViewAttendance: false,
    });
  });

  it("exposes the trust-anchor controls only inside Tauri", () => {
    expect(resolveSurface("/desktop", true)).toEqual({
      kind: "desktop",
      canManageLmsSession: true,
      canPair: true,
      canReceivePersonalNotifications: true,
      canViewAttendance: true,
    });
    expect(resolveSurface("/desktop", false).kind).toBe("public");
  });

  it("treats the remote Tauri root as the desktop surface", () => {
    expect(resolveSurface("/", true).kind).toBe("desktop");
  });

  it("allows a paired mobile companion to receive personal notifications", () => {
    expect(resolveSurface("/app", false)).toEqual({
      kind: "companion",
      canManageLmsSession: false,
      canPair: false,
      canReceivePersonalNotifications: true,
      canViewAttendance: true,
    });
  });
});
