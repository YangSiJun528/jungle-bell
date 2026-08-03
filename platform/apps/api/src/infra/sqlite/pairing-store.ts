import {
  DEVICE_SESSION_SCOPES,
  type DeviceSessionRecord,
  type DeviceSessionScope,
  type PairingChallengeRecord,
  type PairingStore,
} from "../../domain/pairing.js";
import {
  assertNextVersion,
  assertCiphertext,
  expectRow,
  isSqliteUniquenessError,
  parseStringArray,
  readInteger,
  readNullableInteger,
  readNullableText,
  readText,
  serializeStringArray,
  SqliteDataIntegrityError,
} from "./codec.js";
import type { SqliteDatabase } from "./database.js";

export interface PairingApprovalTransportStore {
  commitApprovalWithTransport(input: {
    readonly challenge: PairingChallengeRecord;
    readonly expectedChallengeVersion: number;
    readonly session: DeviceSessionRecord;
    readonly claimId: string;
    readonly approvedSessionCiphertext: string;
    readonly expectedTransportVersion: number;
  }): Promise<boolean>;
}

const APPROVAL_COMMIT_CONFLICT = new Error(
  "PAIRING_APPROVAL_COMMIT_CONFLICT",
);

const CHALLENGE_COLUMNS = `
  challenge_id,
  user_id,
  desktop_device_id,
  pairing_code_hash,
  manual_code_hash,
  status,
  claimed_device_label,
  claimed_installation_id,
  created_at_epoch_ms,
  expires_at_epoch_ms,
  approved_at_epoch_ms,
  version
`;

const CHALLENGE_KEYS = [
  "challenge_id",
  "user_id",
  "desktop_device_id",
  "pairing_code_hash",
  "manual_code_hash",
  "status",
  "claimed_device_label",
  "claimed_installation_id",
  "created_at_epoch_ms",
  "expires_at_epoch_ms",
  "approved_at_epoch_ms",
  "version",
] as const;

const SESSION_COLUMNS = `
  session_id,
  user_id,
  device_id,
  device_label,
  installation_id,
  token_hash,
  scopes_json,
  created_at_epoch_ms,
  expires_at_epoch_ms,
  last_seen_at_epoch_ms,
  revoked_at_epoch_ms,
  version
`;

const SESSION_KEYS = [
  "session_id",
  "user_id",
  "device_id",
  "device_label",
  "installation_id",
  "token_hash",
  "scopes_json",
  "created_at_epoch_ms",
  "expires_at_epoch_ms",
  "last_seen_at_epoch_ms",
  "revoked_at_epoch_ms",
  "version",
] as const;

const ALLOWED_SCOPES = new Set<string>(DEVICE_SESSION_SCOPES);

export class SqlitePairingStore implements PairingStore {
  constructor(private readonly database: SqliteDatabase) {}

  async insertChallenge(
    challenge: PairingChallengeRecord,
  ): Promise<boolean> {
    try {
      const result = this.database
        .prepare(`
          INSERT INTO pairing_challenges (
            ${CHALLENGE_COLUMNS}
          ) VALUES (
            @challengeId,
            @userId,
            @desktopDeviceId,
            @pairingCodeHash,
            @manualCodeHash,
            @status,
            @claimedDeviceLabel,
            @claimedInstallationId,
            @createdAtEpochMs,
            @expiresAtEpochMs,
            @approvedAtEpochMs,
            @version
          )
        `)
        .run(challenge);
      return result.changes === 1;
    } catch (error) {
      if (isSqliteUniquenessError(error)) {
        return false;
      }
      throw error;
    }
  }

  async getChallenge(
    challengeId: string,
  ): Promise<PairingChallengeRecord | null> {
    const row = this.database
      .prepare(`SELECT ${CHALLENGE_COLUMNS} FROM pairing_challenges WHERE challenge_id = ?`)
      .get(challengeId);
    return row === undefined ? null : mapChallenge(row);
  }

  async findChallengeByPairingCodeHash(
    pairingCodeHash: string,
  ): Promise<PairingChallengeRecord | null> {
    const row = this.database
      .prepare(`SELECT ${CHALLENGE_COLUMNS} FROM pairing_challenges WHERE pairing_code_hash = ?`)
      .get(pairingCodeHash);
    return row === undefined ? null : mapChallenge(row);
  }

  async findChallengeByManualCodeHash(
    manualCodeHash: string,
  ): Promise<PairingChallengeRecord | null> {
    const row = this.database
      .prepare(`SELECT ${CHALLENGE_COLUMNS} FROM pairing_challenges WHERE manual_code_hash = ?`)
      .get(manualCodeHash);
    return row === undefined ? null : mapChallenge(row);
  }

  async updateChallenge(
    challenge: PairingChallengeRecord,
    expectedVersion: number,
  ): Promise<boolean> {
    assertNextVersion(challenge.version, expectedVersion);
    if (
      challenge.status !== "claimed" ||
      challenge.claimedDeviceLabel === null ||
      challenge.claimedInstallationId === null ||
      challenge.approvedAtEpochMs !== null
    ) {
      throw new SqliteDataIntegrityError(
        "Challenge update must be a pending-to-claimed transition.",
      );
    }
    const result = this.database
      .prepare(`
        UPDATE pairing_challenges
        SET
          status = @status,
          claimed_device_label = @claimedDeviceLabel,
          claimed_installation_id = @claimedInstallationId,
          approved_at_epoch_ms = @approvedAtEpochMs,
          version = @version
        WHERE challenge_id = @challengeId
          AND version = @expectedVersion
          AND status = 'pending'
          AND claimed_device_label IS NULL
          AND claimed_installation_id IS NULL
          AND approved_at_epoch_ms IS NULL
          AND user_id = @userId
          AND desktop_device_id = @desktopDeviceId
          AND pairing_code_hash = @pairingCodeHash
          AND manual_code_hash = @manualCodeHash
          AND created_at_epoch_ms = @createdAtEpochMs
          AND expires_at_epoch_ms = @expiresAtEpochMs
      `)
      .run({ ...challenge, expectedVersion });
    return result.changes === 1;
  }

  async commitApproval(
    challenge: PairingChallengeRecord,
    expectedChallengeVersion: number,
    session: DeviceSessionRecord,
  ): Promise<boolean> {
    return this.commitApprovalInternal(
      challenge,
      expectedChallengeVersion,
      session,
      null,
    );
  }

  async commitApprovalWithTransport(input: {
    readonly challenge: PairingChallengeRecord;
    readonly expectedChallengeVersion: number;
    readonly session: DeviceSessionRecord;
    readonly claimId: string;
    readonly approvedSessionCiphertext: string;
    readonly expectedTransportVersion: number;
  }): Promise<boolean> {
    assertCiphertext(input.approvedSessionCiphertext);
    if (input.claimId !== input.challenge.challengeId) {
      throw new SqliteDataIntegrityError(
        "Pairing approval transport must match the challenge.",
      );
    }
    return this.commitApprovalInternal(
      input.challenge,
      input.expectedChallengeVersion,
      input.session,
      {
        claimId: input.claimId,
        approvedSessionCiphertext:
          input.approvedSessionCiphertext,
        expectedTransportVersion: input.expectedTransportVersion,
      },
    );
  }

  private commitApprovalInternal(
    challenge: PairingChallengeRecord,
    expectedChallengeVersion: number,
    session: DeviceSessionRecord,
    transport: {
      readonly claimId: string;
      readonly approvedSessionCiphertext: string;
      readonly expectedTransportVersion: number;
    } | null,
  ): boolean {
    assertNextVersion(challenge.version, expectedChallengeVersion);
    if (challenge.status !== "approved" || challenge.approvedAtEpochMs === null) {
      throw new SqliteDataIntegrityError(
        "Approval commit requires an approved challenge.",
      );
    }
    if (session.version !== 0) {
      throw new SqliteDataIntegrityError(
        "A new device session must start at version zero.",
      );
    }
    if (
      session.userId !== challenge.userId ||
      session.deviceLabel !== challenge.claimedDeviceLabel ||
      session.installationId !== challenge.claimedInstallationId ||
      session.createdAtEpochMs !== challenge.approvedAtEpochMs ||
      session.expiresAtEpochMs <= session.createdAtEpochMs ||
      session.lastSeenAtEpochMs !== session.createdAtEpochMs
    ) {
      throw new SqliteDataIntegrityError(
        "Approved session must match the claimed phone and user.",
      );
    }
    const scopesJson = serializeScopes(session.scopes);

    const commit = this.database.transaction(() => {
      this.database
        .prepare(`
          UPDATE push_subscriptions
          SET
            updated_at_epoch_ms = @createdAtEpochMs,
            revoked_at_epoch_ms = @createdAtEpochMs,
            revoked_reason = 'device-revoked'
          WHERE revoked_at_epoch_ms IS NULL
            AND EXISTS (
              SELECT 1
              FROM device_sessions s
              WHERE s.user_id = push_subscriptions.user_id
                AND s.device_id = push_subscriptions.device_id
                AND s.installation_id = @installationId
                AND s.revoked_at_epoch_ms IS NULL
            )
        `)
        .run(session);
      this.database
        .prepare(`
          UPDATE notification_deliveries
          SET
            status = 'cancelled',
            lease_until_epoch_ms = NULL,
            last_error_code = 'INSTALLATION_REPAIRED',
            updated_at_epoch_ms = @createdAtEpochMs
          WHERE channel = 'web-push'
            AND status IN ('pending', 'leased', 'retry', 'awaiting_ack')
            AND EXISTS (
              SELECT 1
              FROM device_sessions s
              WHERE s.user_id = notification_deliveries.user_id
                AND s.device_id = notification_deliveries.device_id
                AND s.installation_id = @installationId
                AND s.revoked_at_epoch_ms IS NULL
            )
        `)
        .run(session);
      this.database
        .prepare(`
          UPDATE device_sessions
          SET
            revoked_at_epoch_ms = @createdAtEpochMs,
            version = version + 1
          WHERE installation_id = @installationId
            AND revoked_at_epoch_ms IS NULL
        `)
        .run(session);
      const challengeUpdate = this.database
        .prepare(`
          UPDATE pairing_challenges
          SET
            status = @status,
            claimed_device_label = @claimedDeviceLabel,
            claimed_installation_id = @claimedInstallationId,
            approved_at_epoch_ms = @approvedAtEpochMs,
            version = @version
          WHERE challenge_id = @challengeId
            AND version = @expectedVersion
            AND status = 'claimed'
            AND claimed_device_label = @claimedDeviceLabel
            AND claimed_installation_id = @claimedInstallationId
            AND approved_at_epoch_ms IS NULL
            AND user_id = @userId
            AND desktop_device_id = @desktopDeviceId
            AND pairing_code_hash = @pairingCodeHash
            AND manual_code_hash = @manualCodeHash
            AND created_at_epoch_ms = @createdAtEpochMs
            AND expires_at_epoch_ms = @expiresAtEpochMs
        `)
        .run({ ...challenge, expectedVersion: expectedChallengeVersion });
      if (challengeUpdate.changes !== 1) {
        throw APPROVAL_COMMIT_CONFLICT;
      }

      const sessionInsert = this.database
        .prepare(`
          INSERT INTO device_sessions (
            session_id,
            pairing_challenge_id,
            user_id,
            device_id,
            device_label,
            installation_id,
            token_hash,
            scopes_json,
            created_at_epoch_ms,
            expires_at_epoch_ms,
            last_seen_at_epoch_ms,
            revoked_at_epoch_ms,
            version
          ) VALUES (
            @sessionId,
            @pairingChallengeId,
            @userId,
            @deviceId,
            @deviceLabel,
            @installationId,
            @tokenHash,
            @scopesJson,
            @createdAtEpochMs,
            @expiresAtEpochMs,
            @lastSeenAtEpochMs,
            @revokedAtEpochMs,
            @version
          )
        `)
        .run({
          ...session,
          pairingChallengeId: challenge.challengeId,
          scopesJson,
        });
      if (sessionInsert.changes !== 1) {
        throw APPROVAL_COMMIT_CONFLICT;
      }
      if (transport !== null) {
        const transportUpdate = this.database
          .prepare(`
            UPDATE pairing_claim_transports
            SET
              approved_session_ciphertext = @approvedSessionCiphertext,
              version = @nextTransportVersion
            WHERE claim_id = @claimId
              AND challenge_id = @claimId
              AND version = @expectedTransportVersion
              AND approved_session_ciphertext IS NULL
              AND delivered_at_epoch_ms IS NULL
              AND expires_at_epoch_ms > @approvedAtEpochMs
          `)
          .run({
            ...transport,
            approvedAtEpochMs: challenge.approvedAtEpochMs,
            nextTransportVersion:
              transport.expectedTransportVersion + 1,
          });
        if (transportUpdate.changes !== 1) {
          throw APPROVAL_COMMIT_CONFLICT;
        }
      }
      return true;
    });

    try {
      return commit.immediate();
    } catch (error) {
      if (
        error === APPROVAL_COMMIT_CONFLICT ||
        isSqliteUniquenessError(error)
      ) {
        return false;
      }
      throw error;
    }
  }

  async getDeviceSession(
    sessionId: string,
  ): Promise<DeviceSessionRecord | null> {
    const row = this.database
      .prepare(`SELECT ${SESSION_COLUMNS} FROM device_sessions WHERE session_id = ?`)
      .get(sessionId);
    return row === undefined ? null : mapSession(row);
  }

  async findDeviceSessionByTokenHash(
    tokenHash: string,
  ): Promise<DeviceSessionRecord | null> {
    const row = this.database
      .prepare(`SELECT ${SESSION_COLUMNS} FROM device_sessions WHERE token_hash = ?`)
      .get(tokenHash);
    return row === undefined ? null : mapSession(row);
  }

  async listDeviceSessions(
    userId: string,
  ): Promise<readonly DeviceSessionRecord[]> {
    return this.database
      .prepare(
        `SELECT ${SESSION_COLUMNS} FROM device_sessions WHERE user_id = ? ORDER BY created_at_epoch_ms, session_id`,
      )
      .all(userId)
      .map(mapSession);
  }

  async touchDeviceSession(input: {
    readonly sessionId: string;
    readonly seenAtEpochMs: number;
    readonly notSeenSinceEpochMs: number;
  }): Promise<void> {
    if (
      !Number.isSafeInteger(input.seenAtEpochMs) ||
      !Number.isSafeInteger(input.notSeenSinceEpochMs) ||
      input.seenAtEpochMs < 0 ||
      input.notSeenSinceEpochMs < 0 ||
      input.notSeenSinceEpochMs > input.seenAtEpochMs
    ) {
      throw new SqliteDataIntegrityError(
        "Device-session activity timestamp is invalid.",
      );
    }
    this.database
      .prepare(`
        UPDATE device_sessions
        SET last_seen_at_epoch_ms = @seenAtEpochMs
        WHERE session_id = @sessionId
          AND revoked_at_epoch_ms IS NULL
          AND expires_at_epoch_ms > @seenAtEpochMs
          AND last_seen_at_epoch_ms <= @notSeenSinceEpochMs
      `)
      .run(input);
  }

  async updateDeviceSession(
    session: DeviceSessionRecord,
    expectedVersion: number,
  ): Promise<boolean> {
    assertNextVersion(session.version, expectedVersion);
    if (session.revokedAtEpochMs === null) {
      throw new SqliteDataIntegrityError(
        "A device-session update cannot clear revocation.",
      );
    }
    const scopesJson = serializeScopes(session.scopes);
    const revoke = this.database.transaction(() => {
      const result = this.database
        .prepare(`
          UPDATE device_sessions
          SET revoked_at_epoch_ms = @revokedAtEpochMs, version = @version
          WHERE session_id = @sessionId
            AND version = @expectedVersion
            AND revoked_at_epoch_ms IS NULL
            AND user_id = @userId
            AND device_id = @deviceId
          AND device_label = @deviceLabel
          AND installation_id = @installationId
            AND token_hash = @tokenHash
            AND scopes_json = @scopesJson
            AND created_at_epoch_ms = @createdAtEpochMs
            AND expires_at_epoch_ms = @expiresAtEpochMs
        `)
        .run({ ...session, scopesJson, expectedVersion });
      if (result.changes !== 1) {
        return false;
      }
      this.database
        .prepare(`
          UPDATE push_subscriptions
          SET
            updated_at_epoch_ms = @revokedAtEpochMs,
            revoked_at_epoch_ms = @revokedAtEpochMs,
            revoked_reason = 'device-revoked'
          WHERE user_id = @userId
            AND device_id = @deviceId
            AND revoked_at_epoch_ms IS NULL
        `)
        .run(session);
      this.database
        .prepare(`
          UPDATE notification_deliveries
          SET
            status = 'cancelled',
            lease_until_epoch_ms = NULL,
            last_error_code = 'DEVICE_REVOKED',
            updated_at_epoch_ms = @revokedAtEpochMs
          WHERE user_id = @userId
            AND device_id = @deviceId
            AND channel = 'web-push'
            AND status IN ('pending', 'leased', 'retry', 'awaiting_ack')
        `)
        .run(session);
      return true;
    });
    return revoke.immediate();
  }
}

function mapChallenge(value: unknown): PairingChallengeRecord {
  const row = expectRow(value, CHALLENGE_KEYS, "pairing challenge");
  const status = readText(row, "status");
  if (status !== "pending" && status !== "claimed" && status !== "approved") {
    throw new SqliteDataIntegrityError(
      "Pairing challenge status is invalid.",
    );
  }

  const challenge: PairingChallengeRecord = {
    challengeId: readText(row, "challenge_id"),
    userId: readText(row, "user_id"),
    desktopDeviceId: readText(row, "desktop_device_id"),
    pairingCodeHash: readText(row, "pairing_code_hash"),
    manualCodeHash: readText(row, "manual_code_hash"),
    status,
    claimedDeviceLabel: readNullableText(row, "claimed_device_label"),
    claimedInstallationId: readNullableText(
      row,
      "claimed_installation_id",
    ),
    createdAtEpochMs: readInteger(row, "created_at_epoch_ms"),
    expiresAtEpochMs: readInteger(row, "expires_at_epoch_ms"),
    approvedAtEpochMs: readNullableInteger(row, "approved_at_epoch_ms"),
    version: readInteger(row, "version"),
  };
  if (
    challenge.expiresAtEpochMs <= challenge.createdAtEpochMs ||
    (challenge.status === "pending" &&
      (challenge.claimedDeviceLabel !== null ||
        challenge.claimedInstallationId !== null ||
        challenge.approvedAtEpochMs !== null)) ||
    (challenge.status === "claimed" &&
      (challenge.claimedDeviceLabel === null ||
        challenge.claimedInstallationId === null ||
        challenge.approvedAtEpochMs !== null)) ||
    (challenge.status === "approved" &&
      (challenge.claimedDeviceLabel === null ||
        challenge.claimedInstallationId === null ||
        challenge.approvedAtEpochMs === null ||
        challenge.approvedAtEpochMs < challenge.createdAtEpochMs ||
        challenge.approvedAtEpochMs >= challenge.expiresAtEpochMs))
  ) {
    throw new SqliteDataIntegrityError(
      "Pairing challenge row violates lifecycle invariants.",
    );
  }
  return challenge;
}

function mapSession(value: unknown): DeviceSessionRecord {
  const row = expectRow(value, SESSION_KEYS, "device session");
  const scopes = parseStringArray(
    readText(row, "scopes_json"),
    "scopes_json",
    {
      allowedValues: ALLOWED_SCOPES,
      requireNonEmpty: true,
    },
  ) as readonly DeviceSessionScope[];

  const session: DeviceSessionRecord = {
    sessionId: readText(row, "session_id"),
    userId: readText(row, "user_id"),
    deviceId: readText(row, "device_id"),
    deviceLabel: readText(row, "device_label"),
    installationId: readText(row, "installation_id"),
    tokenHash: readText(row, "token_hash"),
    scopes,
    createdAtEpochMs: readInteger(row, "created_at_epoch_ms"),
    expiresAtEpochMs: readInteger(row, "expires_at_epoch_ms"),
    lastSeenAtEpochMs: readInteger(row, "last_seen_at_epoch_ms"),
    revokedAtEpochMs: readNullableInteger(row, "revoked_at_epoch_ms"),
    version: readInteger(row, "version"),
  };
  if (
    session.expiresAtEpochMs <= session.createdAtEpochMs ||
    session.lastSeenAtEpochMs < session.createdAtEpochMs ||
    session.lastSeenAtEpochMs >= session.expiresAtEpochMs ||
    (session.revokedAtEpochMs !== null &&
      session.revokedAtEpochMs < session.createdAtEpochMs)
  ) {
    throw new SqliteDataIntegrityError(
      "Device session revocation predates its creation.",
    );
  }
  return session;
}

function serializeScopes(scopes: readonly DeviceSessionScope[]): string {
  return serializeStringArray(scopes, "scopes", {
    allowedValues: ALLOWED_SCOPES,
    requireNonEmpty: true,
  });
}
