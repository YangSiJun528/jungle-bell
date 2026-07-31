import type {
  ClaimTransportRecord,
  ClaimTransportStore,
  DesktopSessionRecord,
  DesktopSessionStore,
} from "./sqlite/session-transport-store.js";

export class InMemoryDesktopSessionStore implements DesktopSessionStore {
  private readonly sessions = new Map<string, DesktopSessionRecord>();

  async insertReplacingActive(
    session: DesktopSessionRecord,
  ): Promise<boolean> {
    if (this.sessions.has(session.tokenHash)) {
      return false;
    }
    for (const [tokenHash, current] of this.sessions) {
      if (
        current.userId === session.userId &&
        current.desktopDeviceId === session.desktopDeviceId &&
        current.revokedAtEpochMs === null &&
        current.expiresAtEpochMs > session.createdAtEpochMs
      ) {
        this.sessions.set(tokenHash, {
          ...current,
          revokedAtEpochMs: Math.max(
            current.createdAtEpochMs,
            session.createdAtEpochMs,
          ),
          version: current.version + 1,
        });
      }
    }
    this.sessions.set(session.tokenHash, { ...session });
    return true;
  }

  async findByTokenHash(
    tokenHash: string,
  ): Promise<DesktopSessionRecord | null> {
    const session = this.sessions.get(tokenHash);
    return session ? { ...session } : null;
  }

  async hasActiveForDevice(input: {
    readonly userId: string;
    readonly desktopDeviceId: string;
    readonly nowEpochMs: number;
  }): Promise<boolean> {
    return [...this.sessions.values()].some(
      (session) =>
        session.userId === input.userId &&
        session.desktopDeviceId === input.desktopDeviceId &&
        session.revokedAtEpochMs === null &&
        session.expiresAtEpochMs > input.nowEpochMs,
    );
  }

  async revoke(input: {
    readonly tokenHash: string;
    readonly revokedAtEpochMs: number;
    readonly expectedVersion: number;
  }): Promise<boolean> {
    const current = this.sessions.get(input.tokenHash);
    if (
      !current ||
      current.version !== input.expectedVersion ||
      current.revokedAtEpochMs !== null
    ) {
      return false;
    }
    this.sessions.set(input.tokenHash, {
      ...current,
      revokedAtEpochMs: input.revokedAtEpochMs,
      version: current.version + 1,
    });
    return true;
  }
}

export class InMemoryClaimTransportStore implements ClaimTransportStore {
  private readonly claims = new Map<string, ClaimTransportRecord>();

  async insert(claim: ClaimTransportRecord): Promise<boolean> {
    if (
      this.claims.has(claim.claimId) ||
      [...this.claims.values()].some(
        (current) =>
          current.challengeId === claim.challengeId ||
          current.receiptHash === claim.receiptHash,
      )
    ) {
      return false;
    }
    this.claims.set(claim.claimId, { ...claim });
    return true;
  }

  async get(claimId: string): Promise<ClaimTransportRecord | null> {
    const claim = this.claims.get(claimId);
    return claim ? { ...claim } : null;
  }

  async setApprovedCiphertext(input: {
    readonly claimId: string;
    readonly approvedSessionCiphertext: string;
    readonly expectedVersion: number;
  }): Promise<boolean> {
    const current = this.claims.get(input.claimId);
    if (
      !current ||
      current.version !== input.expectedVersion ||
      current.approvedSessionCiphertext !== null ||
      current.deliveredAtEpochMs !== null
    ) {
      return false;
    }
    this.claims.set(input.claimId, {
      ...current,
      approvedSessionCiphertext: input.approvedSessionCiphertext,
      version: current.version + 1,
    });
    return true;
  }

  async getApprovedCiphertextForDelivery(input: {
    readonly claimId: string;
    readonly receiptHash: string;
    readonly deliveredAtEpochMs: number;
  }): Promise<string | null> {
    const current = this.claims.get(input.claimId);
    if (
      !current ||
      current.receiptHash !== input.receiptHash ||
      current.approvedSessionCiphertext === null ||
      input.deliveredAtEpochMs < current.createdAtEpochMs ||
      input.deliveredAtEpochMs >= current.expiresAtEpochMs
    ) {
      return null;
    }
    if (current.deliveredAtEpochMs === null) {
      this.claims.set(input.claimId, {
        ...current,
        deliveredAtEpochMs: input.deliveredAtEpochMs,
        version: current.version + 1,
      });
    }
    return current.approvedSessionCiphertext;
  }
}
