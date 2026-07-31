import { beforeEach, describe, expect, it } from "vitest";

import {
  clearPendingPairingSession,
  readPendingPairingSession,
  storePendingPairingSession,
} from "./pairing-session";

const pairingId = `jbc_${"a".repeat(32)}`;
const challenge = `jbp_${"b".repeat(64)}`;
const claim = {
  claimId: pairingId,
  claimReceipt: `jbcr_${"c".repeat(64)}`,
  status: "awaiting-desktop-approval" as const,
};

describe("pending pairing session", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it("keeps only short-lived pairing proof and receipt in session storage", () => {
    storePendingPairingSession({
      pairingId,
      challenge,
      claim,
      expiresAtEpochMs: 10_000,
    });

    expect(readPendingPairingSession(9_999)).toEqual({
      pairingId,
      challenge,
      claim,
      expiresAtEpochMs: 10_000,
    });
    expect(window.localStorage.length).toBe(0);
  });

  it("deletes expired or malformed state", () => {
    storePendingPairingSession({
      pairingId,
      challenge,
      claim: null,
      expiresAtEpochMs: 10_000,
    });
    expect(readPendingPairingSession(10_000)).toBeNull();

    window.sessionStorage.setItem(
      "jungle-bell.pairing-session.v1",
      JSON.stringify({ pairingId: "../invalid" }),
    );
    expect(readPendingPairingSession(1)).toBeNull();
  });

  it("clears the transport state explicitly", () => {
    storePendingPairingSession({
      pairingId,
      challenge: null,
      claim,
      expiresAtEpochMs: 10_000,
    });
    clearPendingPairingSession();
    expect(readPendingPairingSession(1)).toBeNull();
  });
});
