import type { Clock, Hasher, RandomSource } from "./ports.js";

const PAIRING_QR_KIND = "jungle-bell-pairing";
const PAIRING_QR_VERSION = 1;
const SECRET_BYTE_LENGTH = 32;
const IDENTIFIER_BYTE_LENGTH = 16;
const MANUAL_CODE_LENGTH = 10;
const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const DEFAULT_DEVICE_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

export const DEVICE_SESSION_SCOPES = [
  "attendance:read",
  "notifications:receive",
  "preferences:read",
  "preferences:write",
] as const;

export type DeviceSessionScope = (typeof DEVICE_SESSION_SCOPES)[number];

type PairingChallengeStatus = "pending" | "claimed" | "approved";

export interface PairingChallengeRecord {
  readonly challengeId: string;
  readonly userId: string;
  readonly desktopDeviceId: string;
  readonly pairingCodeHash: string;
  readonly manualCodeHash: string;
  readonly status: PairingChallengeStatus;
  readonly claimedDeviceLabel: string | null;
  readonly claimedInstallationId: string | null;
  readonly createdAtEpochMs: number;
  readonly expiresAtEpochMs: number;
  readonly approvedAtEpochMs: number | null;
  readonly version: number;
}

export interface DeviceSessionRecord {
  readonly sessionId: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly deviceLabel: string;
  readonly installationId: string;
  readonly tokenHash: string;
  readonly scopes: readonly DeviceSessionScope[];
  readonly createdAtEpochMs: number;
  readonly revokedAtEpochMs: number | null;
  readonly version: number;
}

export interface PairingStore {
  insertChallenge(challenge: PairingChallengeRecord): Promise<boolean>;
  getChallenge(challengeId: string): Promise<PairingChallengeRecord | null>;
  findChallengeByPairingCodeHash(
    pairingCodeHash: string,
  ): Promise<PairingChallengeRecord | null>;
  findChallengeByManualCodeHash(
    manualCodeHash: string,
  ): Promise<PairingChallengeRecord | null>;
  updateChallenge(
    challenge: PairingChallengeRecord,
    expectedVersion: number,
  ): Promise<boolean>;
  commitApproval(
    challenge: PairingChallengeRecord,
    expectedChallengeVersion: number,
    session: DeviceSessionRecord,
  ): Promise<boolean>;
  getDeviceSession(sessionId: string): Promise<DeviceSessionRecord | null>;
  findDeviceSessionByTokenHash(
    tokenHash: string,
  ): Promise<DeviceSessionRecord | null>;
  listDeviceSessions(userId: string): Promise<readonly DeviceSessionRecord[]>;
  updateDeviceSession(
    session: DeviceSessionRecord,
    expectedVersion: number,
  ): Promise<boolean>;
}

export class PairingDomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PairingDomainError";
  }
}

export interface PairingQrPayload {
  readonly kind: typeof PAIRING_QR_KIND;
  readonly version: typeof PAIRING_QR_VERSION;
  readonly pairingCode: string;
  readonly expiresAtEpochMs: number;
}

export interface PairingServiceDependencies {
  readonly clock: Clock;
  readonly random: RandomSource;
  readonly hasher: Hasher;
  readonly store: PairingStore;
  readonly challengeTtlMs: number;
  readonly deviceSessionTtlMs: number;
}

export interface PairingApprovalProposal {
  readonly challenge: PairingChallengeRecord;
  readonly expectedChallengeVersion: number;
  readonly session: DeviceSessionRecord;
  readonly sessionToken: string;
}

export interface DeviceSessionPrincipal {
  readonly sessionId: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly deviceLabel: string;
  readonly installationId: string;
  readonly scopes: readonly DeviceSessionScope[];
}

export interface DeviceSessionSummary {
  readonly sessionId: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly deviceLabel: string;
  readonly installationId: string;
  readonly scopes: readonly DeviceSessionScope[];
  readonly createdAtEpochMs: number;
  readonly expiresAtEpochMs: number;
  readonly revokedAtEpochMs: number | null;
}

export class InMemoryPairingStore implements PairingStore {
  private readonly challenges = new Map<string, PairingChallengeRecord>();
  private readonly challengeIdByPairingCodeHash = new Map<string, string>();
  private readonly challengeIdByManualCodeHash = new Map<string, string>();
  private readonly sessions = new Map<string, DeviceSessionRecord>();
  private readonly sessionIdByTokenHash = new Map<string, string>();

  async insertChallenge(challenge: PairingChallengeRecord): Promise<boolean> {
    if (
      this.challenges.has(challenge.challengeId) ||
      this.challengeIdByPairingCodeHash.has(challenge.pairingCodeHash) ||
      this.challengeIdByManualCodeHash.has(challenge.manualCodeHash)
    ) {
      return false;
    }

    const copy = cloneChallenge(challenge);
    this.challenges.set(copy.challengeId, copy);
    this.challengeIdByPairingCodeHash.set(
      copy.pairingCodeHash,
      copy.challengeId,
    );
    this.challengeIdByManualCodeHash.set(
      copy.manualCodeHash,
      copy.challengeId,
    );
    return true;
  }

  async getChallenge(
    challengeId: string,
  ): Promise<PairingChallengeRecord | null> {
    const challenge = this.challenges.get(challengeId);
    return challenge ? cloneChallenge(challenge) : null;
  }

  async findChallengeByPairingCodeHash(
    pairingCodeHash: string,
  ): Promise<PairingChallengeRecord | null> {
    const challengeId =
      this.challengeIdByPairingCodeHash.get(pairingCodeHash);
    if (!challengeId) {
      return null;
    }
    return this.getChallenge(challengeId);
  }

  async findChallengeByManualCodeHash(
    manualCodeHash: string,
  ): Promise<PairingChallengeRecord | null> {
    const challengeId =
      this.challengeIdByManualCodeHash.get(manualCodeHash);
    if (!challengeId) {
      return null;
    }
    return this.getChallenge(challengeId);
  }

  async updateChallenge(
    challenge: PairingChallengeRecord,
    expectedVersion: number,
  ): Promise<boolean> {
    const current = this.challenges.get(challenge.challengeId);
    if (!current || current.version !== expectedVersion) {
      return false;
    }
    if (
      current.pairingCodeHash !== challenge.pairingCodeHash ||
      current.manualCodeHash !== challenge.manualCodeHash
    ) {
      return false;
    }

    this.challenges.set(challenge.challengeId, cloneChallenge(challenge));
    return true;
  }

  async commitApproval(
    challenge: PairingChallengeRecord,
    expectedChallengeVersion: number,
    session: DeviceSessionRecord,
  ): Promise<boolean> {
    const currentChallenge = this.challenges.get(challenge.challengeId);
    if (
      !currentChallenge ||
      currentChallenge.version !== expectedChallengeVersion ||
      this.sessions.has(session.sessionId) ||
      this.sessionIdByTokenHash.has(session.tokenHash)
    ) {
      return false;
    }

    for (const [sessionId, existing] of this.sessions) {
      if (
        existing.installationId === session.installationId &&
        existing.revokedAtEpochMs === null
      ) {
        this.sessions.set(sessionId, {
          ...existing,
          revokedAtEpochMs: session.createdAtEpochMs,
          version: existing.version + 1,
        });
      }
    }
    this.challenges.set(challenge.challengeId, cloneChallenge(challenge));
    const sessionCopy = cloneSession(session);
    this.sessions.set(sessionCopy.sessionId, sessionCopy);
    this.sessionIdByTokenHash.set(sessionCopy.tokenHash, sessionCopy.sessionId);
    return true;
  }

  async getDeviceSession(
    sessionId: string,
  ): Promise<DeviceSessionRecord | null> {
    const session = this.sessions.get(sessionId);
    return session ? cloneSession(session) : null;
  }

  async findDeviceSessionByTokenHash(
    tokenHash: string,
  ): Promise<DeviceSessionRecord | null> {
    const sessionId = this.sessionIdByTokenHash.get(tokenHash);
    if (!sessionId) {
      return null;
    }
    return this.getDeviceSession(sessionId);
  }

  async listDeviceSessions(
    userId: string,
  ): Promise<readonly DeviceSessionRecord[]> {
    return [...this.sessions.values()]
      .filter((session) => session.userId === userId)
      .map(cloneSession);
  }

  async updateDeviceSession(
    session: DeviceSessionRecord,
    expectedVersion: number,
  ): Promise<boolean> {
    const current = this.sessions.get(session.sessionId);
    if (
      !current ||
      current.version !== expectedVersion ||
      current.tokenHash !== session.tokenHash
    ) {
      return false;
    }
    this.sessions.set(session.sessionId, cloneSession(session));
    return true;
  }
}

export class PairingService {
  private readonly clock: Clock;
  private readonly random: RandomSource;
  private readonly hasher: Hasher;
  private readonly store: PairingStore;
  private readonly challengeTtlMs: number;
  private readonly deviceSessionTtlMs: number;

  constructor(dependencies: PairingServiceDependencies) {
    if (
      !Number.isSafeInteger(dependencies.challengeTtlMs) ||
      dependencies.challengeTtlMs <= 0
    ) {
      throw new PairingDomainError(
        "INVALID_PAIRING_CONFIGURATION",
        "Pairing challenge TTL must be a positive integer.",
      );
    }
    if (
      !Number.isSafeInteger(dependencies.deviceSessionTtlMs) ||
      dependencies.deviceSessionTtlMs <= 0
    ) {
      throw new PairingDomainError(
        "INVALID_PAIRING_CONFIGURATION",
        "Device session TTL must be a positive integer.",
      );
    }

    this.clock = dependencies.clock;
    this.random = dependencies.random;
    this.hasher = dependencies.hasher;
    this.store = dependencies.store;
    this.challengeTtlMs = dependencies.challengeTtlMs;
    this.deviceSessionTtlMs = dependencies.deviceSessionTtlMs;
  }

  async createChallenge(input: {
    readonly userId: string;
    readonly desktopDeviceId: string;
  }): Promise<{
    readonly challengeId: string;
    readonly qrPayload: string;
    readonly manualCode: string;
    readonly expiresAtEpochMs: number;
  }> {
    assertIdentifier(input.userId, "userId");
    assertIdentifier(input.desktopDeviceId, "desktopDeviceId");

    const createdAtEpochMs = this.clock.now();
    const expiresAtEpochMs = createdAtEpochMs + this.challengeTtlMs;
    if (!Number.isSafeInteger(expiresAtEpochMs)) {
      throw new PairingDomainError(
        "INVALID_PAIRING_CONFIGURATION",
        "Pairing expiry is outside the safe integer range.",
      );
    }

    const challengeId = `jbc_${randomHex(
      this.random,
      IDENTIFIER_BYTE_LENGTH,
    )}`;
    const pairingCode = `jbp_${randomHex(
      this.random,
      SECRET_BYTE_LENGTH,
    )}`;
    const manualCode = randomManualCode(this.random);
    const pairingCodeHash = await this.hasher.hash(pairingCode);
    const manualCodeHash = await this.hasher.hash(manualCode);
    const challenge: PairingChallengeRecord = {
      challengeId,
      userId: input.userId,
      desktopDeviceId: input.desktopDeviceId,
      pairingCodeHash,
      manualCodeHash,
      status: "pending",
      claimedDeviceLabel: null,
      claimedInstallationId: null,
      createdAtEpochMs,
      expiresAtEpochMs,
      approvedAtEpochMs: null,
      version: 0,
    };

    if (!(await this.store.insertChallenge(challenge))) {
      throw new PairingDomainError(
        "PAIRING_IDENTIFIER_COLLISION",
        "Could not allocate a unique pairing challenge.",
      );
    }

    const qrPayload: PairingQrPayload = {
      kind: PAIRING_QR_KIND,
      version: PAIRING_QR_VERSION,
      pairingCode,
      expiresAtEpochMs,
    };
    return {
      challengeId,
      qrPayload: JSON.stringify(qrPayload),
      manualCode,
      expiresAtEpochMs,
    };
  }

  async claimPairing(input: {
    readonly pairingCode?: string;
    readonly manualCode?: string;
    readonly deviceLabel: string;
    readonly installationId: string;
  }): Promise<void> {
    const deviceLabel = normalizeDeviceLabel(input.deviceLabel);
    const installationId = normalizeInstallationId(
      input.installationId,
    );
    const hasPairingCode = input.pairingCode !== undefined;
    const hasManualCode = input.manualCode !== undefined;
    if (hasPairingCode === hasManualCode) {
      throw new PairingDomainError(
        "INVALID_PAIRING_CLAIM",
        "Exactly one pairing proof is required.",
      );
    }
    let challenge: PairingChallengeRecord | null;
    if (input.pairingCode !== undefined) {
      assertPairingCode(input.pairingCode);
      challenge = await this.store.findChallengeByPairingCodeHash(
        await this.hasher.hash(input.pairingCode),
      );
    } else {
      const manualCode = normalizeManualCode(input.manualCode!);
      challenge = await this.store.findChallengeByManualCodeHash(
        await this.hasher.hash(manualCode),
      );
    }

    if (!challenge) {
      throw new PairingDomainError(
        "PAIRING_NOT_FOUND",
        "Pairing proof is invalid.",
      );
    }
    if (challenge.status !== "pending") {
      throw new PairingDomainError(
        "PAIRING_ALREADY_USED",
        "Pairing proof has already been used.",
      );
    }
    assertNotExpired(challenge, this.clock.now());

    const claimed: PairingChallengeRecord = {
      ...challenge,
      status: "claimed",
      claimedDeviceLabel: deviceLabel,
      claimedInstallationId: installationId,
      version: challenge.version + 1,
    };
    if (!(await this.store.updateChallenge(claimed, challenge.version))) {
      throw new PairingDomainError(
        "PAIRING_ALREADY_USED",
        "Pairing proof has already been used.",
      );
    }
  }

  async getPendingClaim(input: {
    readonly challengeId: string;
    readonly desktopDeviceId: string;
  }): Promise<{
    readonly deviceLabel: string;
    readonly installationId: string;
  }> {
    const challenge = await this.requireChallenge(input.challengeId);
    assertDesktopMatches(challenge, input.desktopDeviceId);
    assertNotExpired(challenge, this.clock.now());
    if (
      challenge.status !== "claimed" ||
      !challenge.claimedDeviceLabel ||
      !challenge.claimedInstallationId
    ) {
      throw new PairingDomainError(
        challenge.status === "approved"
          ? "PAIRING_ALREADY_USED"
          : "PAIRING_NOT_CLAIMED",
        "Pairing challenge does not have a pending phone claim.",
      );
    }

    return {
      deviceLabel: challenge.claimedDeviceLabel,
      installationId: challenge.claimedInstallationId,
    };
  }

  async approvePairing(input: {
    readonly challengeId: string;
    readonly desktopDeviceId: string;
    readonly scopes: readonly string[];
  }, commitApproval?: (
    proposal: PairingApprovalProposal,
  ) => Promise<boolean>): Promise<{
    readonly sessionId: string;
    readonly deviceId: string;
    readonly sessionToken: string;
    readonly scopes: readonly DeviceSessionScope[];
  }> {
    const challenge = await this.requireChallenge(input.challengeId);
    assertDesktopMatches(challenge, input.desktopDeviceId);
    if (challenge.status === "approved") {
      throw new PairingDomainError(
        "PAIRING_ALREADY_USED",
        "Pairing challenge has already been approved.",
      );
    }
    if (
      challenge.status !== "claimed" ||
      !challenge.claimedDeviceLabel ||
      !challenge.claimedInstallationId
    ) {
      throw new PairingDomainError(
        "PAIRING_NOT_CLAIMED",
        "Pairing challenge has not been claimed by a phone.",
      );
    }
    const now = this.clock.now();
    assertNotExpired(challenge, now);
    const scopes = normalizeScopes(input.scopes);

    const sessionId = `jbsi_${randomHex(
      this.random,
      IDENTIFIER_BYTE_LENGTH,
    )}`;
    const deviceId = `jbd_${randomHex(
      this.random,
      IDENTIFIER_BYTE_LENGTH,
    )}`;
    const sessionToken = `jbs_${randomHex(
      this.random,
      SECRET_BYTE_LENGTH,
    )}`;
    const tokenHash = await this.hasher.hash(sessionToken);
    const session: DeviceSessionRecord = {
      sessionId,
      userId: challenge.userId,
      deviceId,
      deviceLabel: challenge.claimedDeviceLabel,
      installationId: challenge.claimedInstallationId,
      tokenHash,
      scopes,
      createdAtEpochMs: now,
      revokedAtEpochMs: null,
      version: 0,
    };
    const approved: PairingChallengeRecord = {
      ...challenge,
      status: "approved",
      approvedAtEpochMs: now,
      version: challenge.version + 1,
    };

    const committed =
      commitApproval === undefined
        ? await this.store.commitApproval(
            approved,
            challenge.version,
            session,
          )
        : await commitApproval({
            challenge: approved,
            expectedChallengeVersion: challenge.version,
            session,
            sessionToken,
          });
    if (!committed) {
      throw new PairingDomainError(
        "PAIRING_ALREADY_USED",
        "Pairing challenge has already been approved.",
      );
    }

    return { sessionId, deviceId, sessionToken, scopes: [...scopes] };
  }

  async authenticateDeviceSession(
    sessionToken: string,
    requiredScope?: string,
  ): Promise<DeviceSessionPrincipal> {
    if (!/^jbs_[0-9a-f]{64}$/.test(sessionToken)) {
      throw new PairingDomainError(
        "DEVICE_SESSION_INVALID",
        "Device session is invalid.",
      );
    }
    const tokenHash = await this.hasher.hash(sessionToken);
    const session =
      await this.store.findDeviceSessionByTokenHash(tokenHash);
    if (!session) {
      throw new PairingDomainError(
        "DEVICE_SESSION_INVALID",
        "Device session is invalid.",
      );
    }
    if (session.revokedAtEpochMs !== null) {
      throw new PairingDomainError(
        "DEVICE_SESSION_REVOKED",
        "Device session has been revoked.",
      );
    }
    if (
      session.createdAtEpochMs + this.deviceSessionTtlMs <=
      this.clock.now()
    ) {
      throw new PairingDomainError(
        "DEVICE_SESSION_EXPIRED",
        "Device session has expired.",
      );
    }
    if (requiredScope && !session.scopes.includes(requiredScope as DeviceSessionScope)) {
      throw new PairingDomainError(
        "DEVICE_SESSION_SCOPE_DENIED",
        "Device session does not have the required scope.",
      );
    }

    return {
      sessionId: session.sessionId,
      userId: session.userId,
      deviceId: session.deviceId,
      deviceLabel: session.deviceLabel,
      installationId: session.installationId,
      scopes: [...session.scopes],
    };
  }

  async revokeDeviceSession(input: {
    readonly userId: string;
    readonly sessionId: string;
  }): Promise<DeviceSessionSummary> {
    const session = await this.store.getDeviceSession(input.sessionId);
    if (!session || session.userId !== input.userId) {
      throw new PairingDomainError(
        "DEVICE_SESSION_NOT_FOUND",
        "Device session was not found.",
      );
    }
    if (session.revokedAtEpochMs !== null) {
      return this.toSessionSummary(session);
    }

    const revoked: DeviceSessionRecord = {
      ...session,
      revokedAtEpochMs: this.clock.now(),
      version: session.version + 1,
    };
    if (!(await this.store.updateDeviceSession(revoked, session.version))) {
      const current = await this.store.getDeviceSession(
        input.sessionId,
      );
      if (
        current !== null &&
        current.userId === input.userId &&
        current.revokedAtEpochMs !== null
      ) {
        return this.toSessionSummary(current);
      }
      throw new PairingDomainError(
        "DEVICE_SESSION_CONCURRENT_UPDATE",
        "Device session changed while it was being revoked.",
      );
    }
    return this.toSessionSummary(revoked);
  }

  async revokeDeviceSessionTokenIfPresent(
    sessionToken: string,
  ): Promise<DeviceSessionSummary | null> {
    if (!/^jbs_[0-9a-f]{64}$/.test(sessionToken)) {
      return null;
    }
    const session = await this.store.findDeviceSessionByTokenHash(
      await this.hasher.hash(sessionToken),
    );
    if (session === null) {
      return null;
    }
    return this.revokeDeviceSession({
      userId: session.userId,
      sessionId: session.sessionId,
    });
  }

  async listDeviceSessions(
    userId: string,
  ): Promise<readonly DeviceSessionSummary[]> {
    assertIdentifier(userId, "userId");
    return (await this.store.listDeviceSessions(userId)).map(
      (session) => this.toSessionSummary(session),
    );
  }

  private toSessionSummary(
    session: DeviceSessionRecord,
  ): DeviceSessionSummary {
    return {
      sessionId: session.sessionId,
      userId: session.userId,
      deviceId: session.deviceId,
      deviceLabel: session.deviceLabel,
      installationId: session.installationId,
      scopes: [...session.scopes],
      createdAtEpochMs: session.createdAtEpochMs,
      expiresAtEpochMs:
        session.createdAtEpochMs + this.deviceSessionTtlMs,
      revokedAtEpochMs: session.revokedAtEpochMs,
    };
  }

  private async requireChallenge(
    challengeId: string,
  ): Promise<PairingChallengeRecord> {
    const challenge = await this.store.getChallenge(challengeId);
    if (!challenge) {
      throw new PairingDomainError(
        "PAIRING_NOT_FOUND",
        "Pairing challenge was not found.",
      );
    }
    return challenge;
  }
}

export function decodePairingQrPayload(serialized: string): PairingQrPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw invalidQrPayload();
  }

  if (!isRecord(parsed)) {
    throw invalidQrPayload();
  }
  const keys = Object.keys(parsed).sort();
  if (
    keys.length !== 4 ||
    keys[0] !== "expiresAtEpochMs" ||
    keys[1] !== "kind" ||
    keys[2] !== "pairingCode" ||
    keys[3] !== "version" ||
    parsed.kind !== PAIRING_QR_KIND ||
    parsed.version !== PAIRING_QR_VERSION ||
    typeof parsed.pairingCode !== "string" ||
    !/^jbp_[0-9a-f]{64}$/.test(parsed.pairingCode) ||
    !Number.isSafeInteger(parsed.expiresAtEpochMs)
  ) {
    throw invalidQrPayload();
  }

  return {
    kind: PAIRING_QR_KIND,
    version: PAIRING_QR_VERSION,
    pairingCode: parsed.pairingCode,
    expiresAtEpochMs: parsed.expiresAtEpochMs as number,
  };
}

function cloneChallenge(
  challenge: PairingChallengeRecord,
): PairingChallengeRecord {
  return { ...challenge };
}

function cloneSession(session: DeviceSessionRecord): DeviceSessionRecord {
  return { ...session, scopes: [...session.scopes] };
}

function randomHex(random: RandomSource, byteLength: number): string {
  const bytes = random.bytes(byteLength);
  if (!(bytes instanceof Uint8Array) || bytes.length !== byteLength) {
    throw new PairingDomainError(
      "INVALID_RANDOM_SOURCE",
      `Random source must return exactly ${byteLength} bytes.`,
    );
  }
  return [...bytes]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function randomManualCode(random: RandomSource): string {
  const bytes = random.bytes(MANUAL_CODE_LENGTH);
  if (!(bytes instanceof Uint8Array) || bytes.length !== MANUAL_CODE_LENGTH) {
    throw new PairingDomainError(
      "INVALID_RANDOM_SOURCE",
      `Random source must return exactly ${MANUAL_CODE_LENGTH} bytes.`,
    );
  }
  return [...bytes]
    .map((value) => CROCKFORD_BASE32[value & 31])
    .join("");
}

function assertIdentifier(value: string, field: string): void {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 128 ||
    value.trim() !== value
  ) {
    throw new PairingDomainError(
      "INVALID_PAIRING_INPUT",
      `${field} is invalid.`,
    );
  }
}

function assertPairingCode(value: string): void {
  if (!/^jbp_[0-9a-f]{64}$/.test(value)) {
    throw new PairingDomainError(
      "PAIRING_NOT_FOUND",
      "Pairing proof is invalid.",
    );
  }
}

export function normalizeManualPairingCode(value: string): string {
  return normalizeManualCode(value);
}

function normalizeManualCode(value: string): string {
  if (typeof value !== "string") {
    throw new PairingDomainError(
      "PAIRING_NOT_FOUND",
      "Manual pairing code is invalid.",
    );
  }
  const normalized = value
    .toUpperCase()
    .replace(/[\s-]/gu, "")
    .replace(/[IL]/gu, "1")
    .replace(/O/gu, "0");
  if (
    normalized.length !== MANUAL_CODE_LENGTH ||
    [...normalized].some(
      (character) => !CROCKFORD_BASE32.includes(character),
    )
  ) {
    throw new PairingDomainError(
      "PAIRING_NOT_FOUND",
      "Manual pairing code is invalid.",
    );
  }
  return normalized;
}

function normalizeDeviceLabel(value: string): string {
  if (
    typeof value !== "string" ||
    value.trim().length < 1 ||
    value.trim().length > 80
  ) {
    throw new PairingDomainError(
      "INVALID_PAIRING_CLAIM",
      "Device label is invalid.",
    );
  }
  return value.trim();
}

function normalizeInstallationId(value: string): string {
  if (
    typeof value !== "string" ||
    !/^jbmi_[0-9a-f]{32}$/u.test(value)
  ) {
    throw new PairingDomainError(
      "INVALID_PAIRING_CLAIM",
      "Mobile installation ID is invalid.",
    );
  }
  return value;
}

function normalizeScopes(
  scopes: readonly string[],
): readonly DeviceSessionScope[] {
  if (!Array.isArray(scopes)) {
    throw new PairingDomainError(
      "INVALID_DEVICE_SESSION_SCOPES",
      "Device session scopes are invalid.",
    );
  }
  const allowed = new Set<string>(DEVICE_SESSION_SCOPES);
  if (
    scopes.length < 1 ||
    scopes.some((scope) => typeof scope !== "string" || !allowed.has(scope))
  ) {
    throw new PairingDomainError(
      "INVALID_DEVICE_SESSION_SCOPES",
      "Device session scopes are invalid.",
    );
  }
  return [...new Set(scopes)]
    .sort()
    .map((scope) => scope as DeviceSessionScope);
}

function assertDesktopMatches(
  challenge: PairingChallengeRecord,
  desktopDeviceId: string,
): void {
  if (challenge.desktopDeviceId !== desktopDeviceId) {
    throw new PairingDomainError(
      "PAIRING_DESKTOP_MISMATCH",
      "Only the desktop that created the challenge may approve it.",
    );
  }
}

function assertNotExpired(
  challenge: PairingChallengeRecord,
  nowEpochMs: number,
): void {
  if (nowEpochMs >= challenge.expiresAtEpochMs) {
    throw new PairingDomainError(
      "PAIRING_EXPIRED",
      "Pairing challenge has expired.",
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidQrPayload(): PairingDomainError {
  return new PairingDomainError(
    "INVALID_PAIRING_QR",
    "Pairing QR payload is invalid.",
  );
}
