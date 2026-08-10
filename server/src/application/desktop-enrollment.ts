import { DESKTOP_SESSION_TTL_MS, RenewalError, type Principal } from "../domain/session";
import { hashAppSessionToken, randomOpaqueToken } from "../renewal/crypto";
import type { RenewalStore } from "../workers/account-storage";

export async function enrollDesktop(input: {
  installationId: string;
  store: RenewalStore;
  nowEpochMs: number;
}): Promise<{ accessToken: string; expiresAt: string }> {
  const accessToken = randomOpaqueToken("jbd_");
  const expiresAtEpochMs = input.nowEpochMs + DESKTOP_SESSION_TTL_MS;
  const enrolled = await input.store.enrollDesktop({
    candidateUserId: crypto.randomUUID(), installationId: input.installationId,
    sessionId: `jbas_${crypto.randomUUID()}`, tokenSha256: await hashAppSessionToken(accessToken),
    nowEpochMs: input.nowEpochMs, expiresAtEpochMs,
  });
  if (!enrolled) throw new RenewalError("DESKTOP_ALREADY_ENROLLED", 409);
  return { accessToken, expiresAt: new Date(expiresAtEpochMs).toISOString() };
}

export async function rotateDesktopCredential(input: {
  principal: Principal;
  store: RenewalStore;
  nowEpochMs: number;
}): Promise<{ accessToken: string; expiresAt: string }> {
  if (input.principal.kind !== "desktop") throw new RenewalError("DESKTOP_SESSION_REQUIRED", 403);
  const accessToken = randomOpaqueToken("jbd_");
  const expiresAtEpochMs = input.nowEpochMs + DESKTOP_SESSION_TTL_MS;
  const rotated = await input.store.rotateDesktopSession({
    currentSessionId: input.principal.sessionId, userId: input.principal.userId,
    installationId: input.principal.installationId, newSessionId: `jbas_${crypto.randomUUID()}`,
    tokenSha256: await hashAppSessionToken(accessToken), nowEpochMs: input.nowEpochMs, expiresAtEpochMs,
  });
  if (!rotated) throw new RenewalError("DESKTOP_SESSION_ROTATION_REJECTED", 409);
  return { accessToken, expiresAt: new Date(expiresAtEpochMs).toISOString() };
}
