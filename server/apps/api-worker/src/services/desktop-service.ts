import { DESKTOP_SESSION_TTL_MS, RenewalError, type Principal } from "../domain/session";
import { hashAppSessionToken, randomOpaqueToken } from "@jungle-bell/backend-common/renewal/crypto";
import type { RenewalStore } from "@jungle-bell/backend-common/ports/account-storage";
import { DESKTOP_ENROLLMENT_POLICY } from "@jungle-bell/backend-common/domain/enrollment-policy";

export type DesktopStore = Pick<RenewalStore,
  | "consumeDesktopEnrollmentAttempt"
  | "enrollDesktop"
  | "listActivePushSubscriptions"
  | "listMobileSessions"
  | "recordDesktopHeartbeat"
  | "revokeMobileSession"
  | "rotateDesktopSession"
>;

export async function enrollDesktop(input: {
  installationId: string;
  store: DesktopStore;
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
  store: DesktopStore;
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

export interface DesktopHeartbeatInput {
  lmsSessionState: "connected" | "login-required" | "unknown";
  appVersion: string | null;
}

/** Owns desktop application workflows and keeps storage calls out of controllers. */
export class DesktopService {
  constructor(private readonly store: DesktopStore) {}

  async enroll(installationId: string, rateKeys: readonly [string, string], nowEpochMs: number) {
    const attempts = [
      [rateKeys[0], DESKTOP_ENROLLMENT_POLICY.ipAttemptLimit],
      [rateKeys[1], DESKTOP_ENROLLMENT_POLICY.installationAttemptLimit],
    ] as const;
    for (const [key, limit] of attempts) {
      if (!(await this.store.consumeDesktopEnrollmentAttempt(
        key,
        nowEpochMs,
        DESKTOP_ENROLLMENT_POLICY.windowMs,
        limit,
      ))) return null;
    }
    return enrollDesktop({ installationId, store: this.store, nowEpochMs });
  }

  rotate(principal: Principal, nowEpochMs: number) {
    return rotateDesktopCredential({ principal, store: this.store, nowEpochMs });
  }

  async heartbeat(principal: Principal, body: DesktopHeartbeatInput, nowEpochMs: number) {
    const recorded = await this.store.recordDesktopHeartbeat({
      userId: principal.userId,
      installationId: principal.installationId,
      lmsSessionState: body.lmsSessionState,
      appVersion: body.appVersion,
      nowEpochMs,
    });
    return recorded ? { receivedAt: new Date(nowEpochMs).toISOString() } : null;
  }

  async listMobileSessions(userId: string, nowEpochMs: number) {
    const [sessions, subscriptions] = await Promise.all([
      this.store.listMobileSessions(userId),
      this.store.listActivePushSubscriptions(userId, nowEpochMs),
    ]);
    const pushSessionIds = new Set(subscriptions.map((subscription) => subscription.sessionId));
    return { devices: sessions.map((session) => ({
      deviceId: session.id,
      deviceLabel: session.label ?? "모바일 기기",
      installationId: session.installationId,
      createdAt: new Date(session.createdAtEpochMs).toISOString(),
      expiresAt: new Date(session.expiresAtEpochMs).toISOString(),
      lastSeenAt: new Date(session.lastSeenAtEpochMs).toISOString(),
      pushEnabled: pushSessionIds.has(session.id),
      status: session.revokedAtEpochMs !== null
        ? "revoked" as const
        : session.expiresAtEpochMs <= nowEpochMs ? "expired" as const : "active" as const,
    })) };
  }

  revokeMobileSession(userId: string, sessionId: string, nowEpochMs: number): Promise<boolean> {
    return this.store.revokeMobileSession(userId, sessionId, nowEpochMs);
  }
}
