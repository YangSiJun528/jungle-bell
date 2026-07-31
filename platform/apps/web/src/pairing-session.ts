import type { PairingClaim } from "./api-client";

export const PAIRING_SESSION_TTL_MS = 2 * 60 * 1_000;

const STORAGE_KEY = "jungle-bell.pairing-session.v1";
const PAIRING_ID_PATTERN = /^jbc_[0-9a-f]{32}$/u;
const PAIRING_PROOF_PATTERN = /^jbp_[0-9a-f]{64}$/u;
const CLAIM_RECEIPT_PATTERN = /^jbcr_[0-9a-f]{64}$/u;

export interface PendingPairingSession {
  readonly pairingId: string;
  readonly challenge: string | null;
  readonly claim: PairingClaim | null;
  readonly expiresAtEpochMs: number;
}

export function readPendingPairingSession(
  nowEpochMs = Date.now(),
): PendingPairingSession | null {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (raw === null) {
      return null;
    }
    const parsed = parseStoredPairing(JSON.parse(raw));
    if (parsed === null || parsed.expiresAtEpochMs <= nowEpochMs) {
      clearPendingPairingSession();
      return null;
    }
    return parsed;
  } catch {
    clearPendingPairingSession();
    return null;
  }
}

export function storePendingPairingSession(
  pairing: PendingPairingSession,
): void {
  if (parseStoredPairing(pairing) === null) {
    throw new TypeError("PAIRING_SESSION_INVALID");
  }
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(pairing));
  } catch {
    // Pairing still works in-memory when storage is unavailable.
  }
}

export function clearPendingPairingSession(): void {
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Restricted browser storage is non-fatal.
  }
}

function parseStoredPairing(value: unknown): PendingPairingSession | null {
  if (!isRecord(value)) {
    return null;
  }
  const keys = Object.keys(value);
  if (
    keys.length !== 4 ||
    !keys.includes("pairingId") ||
    !keys.includes("challenge") ||
    !keys.includes("claim") ||
    !keys.includes("expiresAtEpochMs") ||
    typeof value.pairingId !== "string" ||
    !PAIRING_ID_PATTERN.test(value.pairingId) ||
    (value.challenge !== null &&
      (typeof value.challenge !== "string" ||
        !PAIRING_PROOF_PATTERN.test(value.challenge))) ||
    !Number.isSafeInteger(value.expiresAtEpochMs) ||
    (value.expiresAtEpochMs as number) <= 0
  ) {
    return null;
  }
  const claim = value.claim === null ? null : parseClaim(value.claim);
  if (value.claim !== null && claim === null) {
    return null;
  }
  if (value.challenge === null && claim === null) {
    return null;
  }
  return {
    pairingId: value.pairingId,
    challenge: value.challenge,
    claim,
    expiresAtEpochMs: value.expiresAtEpochMs as number,
  };
}

function parseClaim(value: unknown): PairingClaim | null {
  if (!isRecord(value)) {
    return null;
  }
  const keys = Object.keys(value);
  if (
    keys.length !== 3 ||
    !keys.includes("claimId") ||
    !keys.includes("claimReceipt") ||
    !keys.includes("status") ||
    typeof value.claimId !== "string" ||
    !PAIRING_ID_PATTERN.test(value.claimId) ||
    typeof value.claimReceipt !== "string" ||
    !CLAIM_RECEIPT_PATTERN.test(value.claimReceipt) ||
    value.status !== "awaiting-desktop-approval"
  ) {
    return null;
  }
  return {
    claimId: value.claimId,
    claimReceipt: value.claimReceipt,
    status: value.status,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
