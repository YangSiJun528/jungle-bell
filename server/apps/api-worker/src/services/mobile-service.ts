import type { RenewalStore } from "@jungle-bell/backend-common/ports/account-storage";
import type { Principal } from "../domain/session";

export type MobileStore = Pick<RenewalStore, "listMobileSessions" | "revokeMobileSession">;

/** Mobile session workflows independent of HTTP cookies and responses. */
export class MobileService {
  constructor(private readonly store: MobileStore) {}

  async readSession(principal: Principal) {
    const current = (await this.store.listMobileSessions(principal.userId))
      .find((session) => session.id === principal.sessionId);
    return current
      ? { authenticated: true as const, expiresAt: new Date(current.expiresAtEpochMs).toISOString() }
      : null;
  }

  revokeSession(principal: Principal, nowEpochMs: number): Promise<boolean> {
    return this.store.revokeMobileSession(principal.userId, principal.sessionId, nowEpochMs);
  }
}
