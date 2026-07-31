import {
  assertCiphertext,
  assertNextVersion,
  expectRow,
  isSqliteUniquenessError,
  readInteger,
  readNullableInteger,
  readNullableText,
  readText,
  SqliteDataIntegrityError,
} from "./codec.js";
import type { SqliteDatabase } from "./database.js";

export interface DesktopSessionRecord {
  readonly tokenHash: string;
  readonly userId: string;
  readonly desktopDeviceId: string;
  readonly createdAtEpochMs: number;
  readonly expiresAtEpochMs: number;
  readonly revokedAtEpochMs: number | null;
  readonly version: number;
}

export interface DesktopSessionStore {
  /**
   * Inserts the new session and revokes every still-active session for the
   * same user and desktop installation as one store-level operation.
   *
   * A false result means the new token collided and no existing session was
   * changed.
   */
  insertReplacingActive(session: DesktopSessionRecord): Promise<boolean>;
  findByTokenHash(tokenHash: string): Promise<DesktopSessionRecord | null>;
  hasActiveForDevice(input: {
    readonly userId: string;
    readonly desktopDeviceId: string;
    readonly nowEpochMs: number;
  }): Promise<boolean>;
  revoke(input: {
    readonly tokenHash: string;
    readonly revokedAtEpochMs: number;
    readonly expectedVersion: number;
  }): Promise<boolean>;
}

export interface ClaimTransportRecord {
  readonly claimId: string;
  readonly challengeId: string;
  readonly receiptHash: string;
  readonly approvedSessionCiphertext: string | null;
  readonly createdAtEpochMs: number;
  readonly expiresAtEpochMs: number;
  readonly deliveredAtEpochMs: number | null;
  readonly version: number;
}

export interface ClaimTransportStore {
  insert(claim: ClaimTransportRecord): Promise<boolean>;
  get(claimId: string): Promise<ClaimTransportRecord | null>;
  setApprovedCiphertext(input: {
    readonly claimId: string;
    readonly approvedSessionCiphertext: string;
    readonly expectedVersion: number;
  }): Promise<boolean>;
  getApprovedCiphertextForDelivery(input: {
    readonly claimId: string;
    readonly receiptHash: string;
    readonly deliveredAtEpochMs: number;
  }): Promise<string | null>;
}

const DESKTOP_SESSION_COLUMNS = `
  token_hash,
  user_id,
  desktop_device_id,
  created_at_epoch_ms,
  expires_at_epoch_ms,
  revoked_at_epoch_ms,
  version
`;

const DESKTOP_SESSION_KEYS = [
  "token_hash",
  "user_id",
  "desktop_device_id",
  "created_at_epoch_ms",
  "expires_at_epoch_ms",
  "revoked_at_epoch_ms",
  "version",
] as const;

const CLAIM_COLUMNS = `
  claim_id,
  challenge_id,
  receipt_hash,
  approved_session_ciphertext,
  created_at_epoch_ms,
  expires_at_epoch_ms,
  delivered_at_epoch_ms,
  version
`;

const CLAIM_KEYS = [
  "claim_id",
  "challenge_id",
  "receipt_hash",
  "approved_session_ciphertext",
  "created_at_epoch_ms",
  "expires_at_epoch_ms",
  "delivered_at_epoch_ms",
  "version",
] as const;

export class SqliteDesktopSessionStore implements DesktopSessionStore {
  constructor(private readonly database: SqliteDatabase) {}

  async insertReplacingActive(
    session: DesktopSessionRecord,
  ): Promise<boolean> {
    const rotate = this.database.transaction(() => {
      this.database
        .prepare(`
          UPDATE desktop_sessions
          SET
            revoked_at_epoch_ms = MAX(
              created_at_epoch_ms,
              @createdAtEpochMs
            ),
            version = version + 1
          WHERE user_id = @userId
            AND desktop_device_id = @desktopDeviceId
            AND revoked_at_epoch_ms IS NULL
            AND expires_at_epoch_ms > @createdAtEpochMs
        `)
        .run(session);

      const result = this.database
        .prepare(`
          INSERT INTO desktop_sessions (
            ${DESKTOP_SESSION_COLUMNS}
          ) VALUES (
            @tokenHash,
            @userId,
            @desktopDeviceId,
            @createdAtEpochMs,
            @expiresAtEpochMs,
            @revokedAtEpochMs,
            @version
          )
        `)
        .run(session);
      return result.changes === 1;
    });

    try {
      return rotate.immediate();
    } catch (error) {
      if (isSqliteUniquenessError(error)) {
        return false;
      }
      throw error;
    }
  }

  async findByTokenHash(
    tokenHash: string,
  ): Promise<DesktopSessionRecord | null> {
    const row = this.database
      .prepare(
        `SELECT ${DESKTOP_SESSION_COLUMNS} FROM desktop_sessions WHERE token_hash = ?`,
      )
      .get(tokenHash);
    return row === undefined ? null : mapDesktopSession(row);
  }

  async hasActiveForDevice(input: {
    readonly userId: string;
    readonly desktopDeviceId: string;
    readonly nowEpochMs: number;
  }): Promise<boolean> {
    const row = this.database
      .prepare(`
        SELECT 1
        FROM desktop_sessions
        WHERE user_id = @userId
          AND desktop_device_id = @desktopDeviceId
          AND revoked_at_epoch_ms IS NULL
          AND expires_at_epoch_ms > @nowEpochMs
        LIMIT 1
      `)
      .get(input);
    return row !== undefined;
  }

  async revoke(input: {
    readonly tokenHash: string;
    readonly revokedAtEpochMs: number;
    readonly expectedVersion: number;
  }): Promise<boolean> {
    const result = this.database
      .prepare(`
        UPDATE desktop_sessions
        SET
          revoked_at_epoch_ms = @revokedAtEpochMs,
          version = @nextVersion
        WHERE token_hash = @tokenHash
          AND version = @expectedVersion
          AND revoked_at_epoch_ms IS NULL
      `)
      .run({ ...input, nextVersion: input.expectedVersion + 1 });
    return result.changes === 1;
  }
}

export class SqliteClaimTransportStore implements ClaimTransportStore {
  constructor(private readonly database: SqliteDatabase) {}

  async insert(claim: ClaimTransportRecord): Promise<boolean> {
    if (claim.approvedSessionCiphertext !== null) {
      assertCiphertext(claim.approvedSessionCiphertext);
    }
    try {
      const result = this.database
        .prepare(`
          INSERT INTO pairing_claim_transports (
            ${CLAIM_COLUMNS}
          ) VALUES (
            @claimId,
            @challengeId,
            @receiptHash,
            @approvedSessionCiphertext,
            @createdAtEpochMs,
            @expiresAtEpochMs,
            @deliveredAtEpochMs,
            @version
          )
        `)
        .run(claim);
      return result.changes === 1;
    } catch (error) {
      if (isSqliteUniquenessError(error)) {
        return false;
      }
      throw error;
    }
  }

  async get(claimId: string): Promise<ClaimTransportRecord | null> {
    const row = this.database
      .prepare(
        `SELECT ${CLAIM_COLUMNS} FROM pairing_claim_transports WHERE claim_id = ?`,
      )
      .get(claimId);
    return row === undefined ? null : mapClaimTransport(row);
  }

  async setApprovedCiphertext(input: {
    readonly claimId: string;
    readonly approvedSessionCiphertext: string;
    readonly expectedVersion: number;
  }): Promise<boolean> {
    assertCiphertext(input.approvedSessionCiphertext);
    const nextVersion = input.expectedVersion + 1;
    assertNextVersion(nextVersion, input.expectedVersion);
    const result = this.database
      .prepare(`
        UPDATE pairing_claim_transports
        SET
          approved_session_ciphertext = @approvedSessionCiphertext,
          version = @nextVersion
        WHERE claim_id = @claimId
          AND version = @expectedVersion
          AND approved_session_ciphertext IS NULL
          AND delivered_at_epoch_ms IS NULL
      `)
      .run({ ...input, nextVersion });
    return result.changes === 1;
  }

  async getApprovedCiphertextForDelivery(input: {
    readonly claimId: string;
    readonly receiptHash: string;
    readonly deliveredAtEpochMs: number;
  }): Promise<string | null> {
    if (
      !Number.isSafeInteger(input.deliveredAtEpochMs) ||
      input.deliveredAtEpochMs < 0
    ) {
      throw new SqliteDataIntegrityError(
        "Delivery time must be a non-negative safe integer.",
      );
    }

    const consume = this.database.transaction(() => {
      const row = this.database
        .prepare(
          `SELECT ${CLAIM_COLUMNS} FROM pairing_claim_transports WHERE claim_id = ? AND receipt_hash = ?`,
        )
        .get(input.claimId, input.receiptHash);
      if (row === undefined) {
        return null;
      }
      const claim = mapClaimTransport(row);
      if (
        claim.approvedSessionCiphertext === null ||
        input.deliveredAtEpochMs < claim.createdAtEpochMs ||
        input.deliveredAtEpochMs >= claim.expiresAtEpochMs
      ) {
        return null;
      }
      if (claim.deliveredAtEpochMs !== null) {
        return claim.approvedSessionCiphertext;
      }

      const result = this.database
        .prepare(`
          UPDATE pairing_claim_transports
          SET
            delivered_at_epoch_ms = @deliveredAtEpochMs,
            version = @nextVersion
          WHERE claim_id = @claimId
            AND receipt_hash = @receiptHash
            AND version = @expectedVersion
            AND delivered_at_epoch_ms IS NULL
            AND approved_session_ciphertext = @approvedSessionCiphertext
            AND expires_at_epoch_ms > @deliveredAtEpochMs
        `)
        .run({
          ...input,
          approvedSessionCiphertext: claim.approvedSessionCiphertext,
          expectedVersion: claim.version,
          nextVersion: claim.version + 1,
        });
      return result.changes === 1
        ? claim.approvedSessionCiphertext
        : null;
    });

    return consume.immediate();
  }
}

function mapDesktopSession(value: unknown): DesktopSessionRecord {
  const row = expectRow(value, DESKTOP_SESSION_KEYS, "desktop session");
  const session: DesktopSessionRecord = {
    tokenHash: readText(row, "token_hash"),
    userId: readText(row, "user_id"),
    desktopDeviceId: readText(row, "desktop_device_id"),
    createdAtEpochMs: readInteger(row, "created_at_epoch_ms"),
    expiresAtEpochMs: readInteger(row, "expires_at_epoch_ms"),
    revokedAtEpochMs: readNullableInteger(row, "revoked_at_epoch_ms"),
    version: readInteger(row, "version"),
  };
  if (
    session.expiresAtEpochMs <= session.createdAtEpochMs ||
    (session.revokedAtEpochMs !== null &&
      session.revokedAtEpochMs < session.createdAtEpochMs)
  ) {
    throw new SqliteDataIntegrityError(
      "Desktop session row violates lifecycle invariants.",
    );
  }
  return session;
}

function mapClaimTransport(value: unknown): ClaimTransportRecord {
  const row = expectRow(value, CLAIM_KEYS, "pairing claim transport");
  const approvedSessionCiphertext = readNullableText(
    row,
    "approved_session_ciphertext",
  );
  if (approvedSessionCiphertext !== null) {
    assertCiphertext(approvedSessionCiphertext);
  }
  const claim: ClaimTransportRecord = {
    claimId: readText(row, "claim_id"),
    challengeId: readText(row, "challenge_id"),
    receiptHash: readText(row, "receipt_hash"),
    approvedSessionCiphertext,
    createdAtEpochMs: readInteger(row, "created_at_epoch_ms"),
    expiresAtEpochMs: readInteger(row, "expires_at_epoch_ms"),
    deliveredAtEpochMs: readNullableInteger(row, "delivered_at_epoch_ms"),
    version: readInteger(row, "version"),
  };
  if (
    claim.expiresAtEpochMs <= claim.createdAtEpochMs ||
    (claim.deliveredAtEpochMs !== null &&
      (claim.approvedSessionCiphertext === null ||
        claim.deliveredAtEpochMs < claim.createdAtEpochMs ||
        claim.deliveredAtEpochMs >= claim.expiresAtEpochMs))
  ) {
    throw new SqliteDataIntegrityError(
      "Pairing claim transport row violates lifecycle invariants.",
    );
  }
  return claim;
}
