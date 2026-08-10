import {
  deriveMobileSessionToken,
  hmacSha256Hex,
  normalizeManualPairingCode,
  randomManualPairingCode,
  randomOpaqueToken,
  sha256Hex,
} from "./crypto";
import type { LmsAccessCookie, LmsIdentityGateway } from "./lms-gateway";
import type {
  AppSessionRecord,
  PairingRecord,
  RenewalStore,
} from "../workers/account-storage";

export const DESKTOP_SESSION_TTL_MS = 90 * 24 * 60 * 60_000;
export const MOBILE_SESSION_TTL_MS = 365 * 24 * 60 * 60_000;
export const PAIRING_TTL_MS = 2 * 60_000;

export type PairingStatus = "pending" | "claimed" | "approved" | "completed" | "expired";

export function pairingStatusAt(pairing: PairingRecord, nowEpochMs: number): PairingStatus {
  if (pairing.status === "consumed") return "completed";
  if (pairing.status === "approved") {
    return pairing.approvedAtEpochMs !== null
      && pairing.approvedAtEpochMs + MOBILE_SESSION_TTL_MS > nowEpochMs
      ? "approved"
      : "expired";
  }
  return pairing.expiresAtEpochMs > nowEpochMs ? pairing.status : "expired";
}

export class RenewalError extends Error {
  constructor(readonly code: string, readonly status: 400 | 401 | 403 | 404 | 409 | 410 | 502 | 503 = 400) {
    super(code);
    this.name = "RenewalError";
  }
}

export interface Principal {
  sessionId: string;
  userId: string;
  installationId: string;
  kind: "desktop" | "mobile";
}

export async function verifyLmsAndIssueDesktopSession(input: {
  installationId: string;
  cookies: readonly LmsAccessCookie[];
  gateway: LmsIdentityGateway;
  store: RenewalStore;
  nowEpochMs: number;
}): Promise<{ accessToken: string; expiresAt: string }> {
  const verified = await input.gateway.verifyIdentity(input.cookies);
  if (!verified.authenticated) throw new RenewalError("LMS_SESSION_REJECTED", 401);
  if (verified.subject === null) throw new RenewalError("LMS_IDENTITY_UNAVAILABLE", 502);
  const subjectSha256 = await sha256Hex(verified.subject);
  const accessToken = randomOpaqueToken("jba_");
  const expiresAtEpochMs = input.nowEpochMs + DESKTOP_SESSION_TTL_MS;
  await input.store.issueVerifiedDesktopSession({
    candidateUserId: crypto.randomUUID(),
    subjectSha256,
    installationId: input.installationId,
    sessionId: `jbas_${crypto.randomUUID()}`,
    tokenSha256: await sha256Hex(accessToken),
    nowEpochMs: input.nowEpochMs,
    expiresAtEpochMs,
  });
  return { accessToken, expiresAt: new Date(expiresAtEpochMs).toISOString() };
}

export async function authenticateSession(store: RenewalStore, token: string, nowEpochMs: number, kind?: "desktop" | "mobile"): Promise<Principal> {
  if (!/^jb[as]_[0-9a-f]{64}$/u.test(token)) throw new RenewalError("AUTHENTICATION_REQUIRED", 401);
  const session = await store.findSessionByTokenHash(await sha256Hex(token));
  if (!session || session.revokedAtEpochMs !== null) throw new RenewalError("AUTHENTICATION_REQUIRED", 401);
  if (session.expiresAtEpochMs <= nowEpochMs) throw new RenewalError("SESSION_EXPIRED", 401);
  if (kind && session.kind !== kind) throw new RenewalError("SESSION_KIND_DENIED", 403);
  if (session.kind === "desktop" && !(await store.hasCurrentDesktopOwnership({
    sessionId: session.id,
    userId: session.userId,
    installationId: session.installationId,
  }))) throw new RenewalError("AUTHENTICATION_REQUIRED", 401);
  await store.touchSession(session.id, nowEpochMs);
  return { sessionId: session.id, userId: session.userId, installationId: session.installationId, kind: session.kind };
}

export async function createPairing(input: {
  principal: Principal;
  store: RenewalStore;
  pairingSecret: string;
  publicOrigin: string;
  nowEpochMs: number;
}): Promise<{ pairingId: string; qrPayload: string; manualCode: string; expiresAt: string }> {
  if (input.principal.kind !== "desktop") throw new RenewalError("DESKTOP_SESSION_REQUIRED", 403);
  const id = `jbp_${crypto.randomUUID()}`;
  const qrSecret = randomOpaqueToken("jbpc_");
  const manualCode = randomManualPairingCode();
  const expiresAtEpochMs = input.nowEpochMs + PAIRING_TTL_MS;
  const record: PairingRecord = {
    id,
    userId: input.principal.userId,
    desktopInstallationId: input.principal.installationId,
    pairingSecretSha256: await sha256Hex(qrSecret),
    manualCodeHash: await hmacSha256Hex(input.pairingSecret, manualCode),
    claimReceiptSha256: null,
    status: "pending",
    mobileInstallationId: null,
    mobileLabel: null,
    createdAtEpochMs: input.nowEpochMs,
    expiresAtEpochMs,
    approvedAtEpochMs: null,
  };
  if (!(await input.store.createPairing(record))) throw new RenewalError("PAIRING_COLLISION", 503);
  const fragment = new URLSearchParams({ pairing: id, challenge: qrSecret });
  return {
    pairingId: id,
    qrPayload: `${input.publicOrigin}/dashboard.html#${fragment.toString()}`,
    manualCode,
    expiresAt: new Date(expiresAtEpochMs).toISOString(),
  };
}

export async function claimPairing(input: {
  store: RenewalStore;
  pairingSecret: string;
  pairingId?: string;
  challenge?: string;
  manualCode?: string;
  installationId: string;
  deviceLabel: string;
  nowEpochMs: number;
}): Promise<{ claimId: string; claimReceipt: string; status: "awaiting-desktop-approval" }> {
  const qrClaim = input.challenge !== undefined;
  const manualClaim = input.manualCode !== undefined;
  if (qrClaim === manualClaim) throw new RenewalError("INVALID_PAIRING_CLAIM");
  let record: PairingRecord | null;
  if (input.challenge !== undefined) {
    if (!/^jbpc_[0-9a-f]{64}$/u.test(input.challenge)) throw new RenewalError("PAIRING_NOT_FOUND", 404);
    record = await input.store.findPairingByProof("qr", await sha256Hex(input.challenge));
    if (!record || record.id !== input.pairingId) throw new RenewalError("PAIRING_NOT_FOUND", 404);
  } else {
    const manualCode = normalizeManualPairingCode(input.manualCode!);
    if (!manualCode) throw new RenewalError("PAIRING_NOT_FOUND", 404);
    record = await input.store.findPairingByProof("manual", await hmacSha256Hex(input.pairingSecret, manualCode));
    if (!record) throw new RenewalError("PAIRING_NOT_FOUND", 404);
  }
  if (record.expiresAtEpochMs <= input.nowEpochMs) throw new RenewalError("PAIRING_EXPIRED", 410);
  if (record.status !== "pending") throw new RenewalError("PAIRING_ALREADY_USED", 409);
  const claimReceipt = randomOpaqueToken("jbcr_");
  const claimed = await input.store.claimPairing({
    id: record.id,
    receiptSha256: await sha256Hex(claimReceipt),
    mobileInstallationId: input.installationId,
    mobileLabel: input.deviceLabel,
    nowEpochMs: input.nowEpochMs,
  });
  if (!claimed) throw new RenewalError("PAIRING_ALREADY_USED", 409);
  return { claimId: record.id, claimReceipt, status: "awaiting-desktop-approval" };
}

export async function approvePairing(input: {
  store: RenewalStore;
  principal: Principal;
  pairingId: string;
  pairingSecret: string;
  nowEpochMs: number;
}): Promise<void> {
  if (input.principal.kind !== "desktop") throw new RenewalError("DESKTOP_SESSION_REQUIRED", 403);
  const pairing = await input.store.getPairing(input.pairingId);
  if (!pairing || pairing.userId !== input.principal.userId || pairing.desktopInstallationId !== input.principal.installationId) {
    throw new RenewalError("PAIRING_NOT_FOUND", 404);
  }
  if (pairing.expiresAtEpochMs <= input.nowEpochMs) throw new RenewalError("PAIRING_EXPIRED", 410);
  if (pairing.status !== "claimed" || !pairing.claimReceiptSha256 || !pairing.mobileInstallationId || !pairing.mobileLabel) {
    throw new RenewalError(pairing.status === "pending" ? "PAIRING_NOT_CLAIMED" : "PAIRING_ALREADY_USED", 409);
  }
  const token = await deriveMobileSessionToken(input.pairingSecret, pairing.claimReceiptSha256);
  const expiresAtEpochMs = input.nowEpochMs + MOBILE_SESSION_TTL_MS;
  const session: AppSessionRecord = {
    id: `jbsi_${crypto.randomUUID()}`,
    userId: pairing.userId,
    installationId: pairing.mobileInstallationId,
    kind: "mobile",
    label: pairing.mobileLabel,
    tokenSha256: await sha256Hex(token),
    createdAtEpochMs: input.nowEpochMs,
    expiresAtEpochMs,
    lastSeenAtEpochMs: input.nowEpochMs,
    revokedAtEpochMs: null,
    sourcePairingId: pairing.id,
  };
  if (!(await input.store.approvePairing(pairing.id, input.principal.installationId, session, input.nowEpochMs))) {
    throw new RenewalError("PAIRING_ALREADY_USED", 409);
  }
}

export async function completePairing(input: {
  store: RenewalStore;
  pairingId: string;
  claimReceipt: string;
  pairingSecret: string;
  nowEpochMs: number;
}): Promise<{ token: string; expiresAtEpochMs: number }> {
  if (!/^jbcr_[0-9a-f]{64}$/u.test(input.claimReceipt)) throw new RenewalError("PAIRING_RECEIPT_INVALID", 401);
  const receiptHash = await sha256Hex(input.claimReceipt);
  const pairing = await input.store.getPairing(input.pairingId);
  if (!pairing || pairing.claimReceiptSha256 !== receiptHash) throw new RenewalError("PAIRING_RECEIPT_INVALID", 401);
  if (pairing.approvedAtEpochMs === null || (pairing.status !== "approved" && pairing.status !== "consumed")) {
    throw new RenewalError("PAIRING_NOT_APPROVED", 409);
  }
  if (pairing.approvedAtEpochMs + MOBILE_SESSION_TTL_MS <= input.nowEpochMs) {
    throw new RenewalError("PAIRING_EXPIRED", 410);
  }
  if (pairing.status === "approved" && !(await input.store.consumePairing(pairing.id, receiptHash, input.nowEpochMs))) {
    const current = await input.store.getPairing(pairing.id);
    if (current?.status !== "consumed" || current.claimReceiptSha256 !== receiptHash) throw new RenewalError("PAIRING_EXPIRED", 410);
  }
  return {
    token: await deriveMobileSessionToken(input.pairingSecret, receiptHash),
    expiresAtEpochMs: pairing.approvedAtEpochMs + MOBILE_SESSION_TTL_MS,
  };
}
