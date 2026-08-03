import {
  expectRow,
  readInteger,
  readNullableInteger,
  readNullableText,
  readText,
  SqliteDataIntegrityError,
} from "./codec.js";
import type { SqliteDatabase } from "./database.js";

export const LMS_IDENTITY_PROVIDER = "jungle_lms";
export const DESKTOP_LMS_SESSION_STATES = [
  "unknown",
  "connected",
  "login-required",
] as const;

export type DesktopLmsSessionState =
  (typeof DESKTOP_LMS_SESSION_STATES)[number];

export interface VerifiedDesktopIdentityInput {
  readonly candidateUserId: string;
  readonly desktopDeviceId: string;
  readonly subjectSha256: string;
  readonly verifiedAtEpochMs: number;
}

export interface VerifiedDesktopIdentity {
  readonly userId: string;
  readonly desktopDeviceId: string;
  readonly createdUser: boolean;
}

export interface DesktopDeviceRecord {
  readonly userId: string;
  readonly desktopDeviceId: string;
  readonly registeredAtEpochMs: number;
  readonly lastVerifiedAtEpochMs: number;
  readonly lastSeenAtEpochMs: number | null;
  readonly lmsSessionState: DesktopLmsSessionState;
  readonly appVersion: string | null;
}

export interface DesktopIdentityStore {
  registerVerifiedIdentity(
    input: VerifiedDesktopIdentityInput,
  ): Promise<VerifiedDesktopIdentity>;
  recordHeartbeat(
    input: {
      readonly userId: string;
      readonly desktopDeviceId: string;
      readonly receivedAtEpochMs: number;
      readonly lmsSessionState: DesktopLmsSessionState;
      readonly appVersion: string | null;
    },
    /**
     * Runs synchronously inside the same state transition. Throwing aborts
     * the heartbeat so a later retry can attempt the durable side effect.
     */
    onLoginRequiredTransition?: () => void,
  ): Promise<DesktopDeviceRecord | null>;
  getDesktopDevice(
    userId: string,
    desktopDeviceId: string,
  ): Promise<DesktopDeviceRecord | null>;
  listDesktopDevices(userId: string): Promise<readonly DesktopDeviceRecord[]>;
}

const DEVICE_COLUMNS = `
  user_id,
  desktop_device_id,
  registered_at_epoch_ms,
  last_verified_at_epoch_ms,
  last_seen_at_epoch_ms,
  lms_session_state,
  app_version
`;

const DEVICE_KEYS = [
  "user_id",
  "desktop_device_id",
  "registered_at_epoch_ms",
  "last_verified_at_epoch_ms",
  "last_seen_at_epoch_ms",
  "lms_session_state",
  "app_version",
] as const;

export class SqliteDesktopIdentityStore implements DesktopIdentityStore {
  constructor(private readonly database: SqliteDatabase) {}

  async registerVerifiedIdentity(
    input: VerifiedDesktopIdentityInput,
  ): Promise<VerifiedDesktopIdentity> {
    assertIdentifier(input.candidateUserId, "candidate user ID");
    assertIdentifier(input.desktopDeviceId, "desktop device ID");
    assertSubjectSha256(input.subjectSha256);
    assertEpoch(input.verifiedAtEpochMs, "verification time");

    const register = this.database.transaction(() => {
      const existing = this.database
        .prepare(
          `SELECT user_id
           FROM external_identities
           WHERE provider = ? AND subject_sha256 = ?`,
        )
        .get(LMS_IDENTITY_PROVIDER, input.subjectSha256);

      let userId: string;
      let createdUser = false;
      if (existing === undefined) {
        userId = input.candidateUserId;
        const insertedUser = this.database
          .prepare(`
            INSERT INTO users (
              id,
              status,
              created_at_epoch_ms
            ) VALUES (?, 'active', ?)
          `)
          .run(userId, input.verifiedAtEpochMs);
        if (insertedUser.changes !== 1) {
          throw new SqliteDataIntegrityError(
            "Verified LMS identity did not create a user.",
          );
        }
        this.database
          .prepare(`
            INSERT INTO external_identities (
              provider,
              subject_sha256,
              hash_version,
              user_id,
              linked_at_epoch_ms,
              last_verified_at_epoch_ms
            ) VALUES (?, ?, 1, ?, ?, ?)
          `)
          .run(
            LMS_IDENTITY_PROVIDER,
            input.subjectSha256,
            userId,
            input.verifiedAtEpochMs,
            input.verifiedAtEpochMs,
          );
        createdUser = true;
      } else {
        userId = readText(
          expectRow(existing, ["user_id"], "external identity"),
          "user_id",
        );
        this.database
          .prepare(`
            UPDATE external_identities
            SET last_verified_at_epoch_ms = max(
              last_verified_at_epoch_ms,
              @verifiedAtEpochMs
            )
            WHERE provider = @provider
              AND subject_sha256 = @subjectSha256
          `)
          .run({
            provider: LMS_IDENTITY_PROVIDER,
            subjectSha256: input.subjectSha256,
            verifiedAtEpochMs: input.verifiedAtEpochMs,
          });
      }

      this.database
        .prepare(`
          INSERT INTO desktop_devices (
            user_id,
            desktop_device_id,
            registered_at_epoch_ms,
            last_verified_at_epoch_ms,
            last_seen_at_epoch_ms,
            lms_session_state,
            app_version
          ) VALUES (
            @userId,
            @desktopDeviceId,
            @verifiedAtEpochMs,
            @verifiedAtEpochMs,
            @verifiedAtEpochMs,
            'connected',
            NULL
          )
          ON CONFLICT (user_id, desktop_device_id) DO UPDATE SET
            last_verified_at_epoch_ms = max(
              desktop_devices.last_verified_at_epoch_ms,
              excluded.last_verified_at_epoch_ms
            ),
            last_seen_at_epoch_ms = max(
              COALESCE(desktop_devices.last_seen_at_epoch_ms, 0),
              excluded.last_seen_at_epoch_ms
            ),
            lms_session_state = 'connected'
        `)
        .run({
          userId,
          desktopDeviceId: input.desktopDeviceId,
          verifiedAtEpochMs: input.verifiedAtEpochMs,
        });

      return {
        userId,
        desktopDeviceId: input.desktopDeviceId,
        createdUser,
      };
    });

    return register.immediate();
  }

  async recordHeartbeat(
    input: {
      readonly userId: string;
      readonly desktopDeviceId: string;
      readonly receivedAtEpochMs: number;
      readonly lmsSessionState: DesktopLmsSessionState;
      readonly appVersion: string | null;
    },
    onLoginRequiredTransition?: () => void,
  ): Promise<DesktopDeviceRecord | null> {
    assertIdentifier(input.userId, "user ID");
    assertIdentifier(input.desktopDeviceId, "desktop device ID");
    assertEpoch(input.receivedAtEpochMs, "heartbeat time");
    assertLmsSessionState(input.lmsSessionState);
    assertAppVersion(input.appVersion);

    const record = this.database.transaction(() => {
      const previousValue = this.database
        .prepare(`
          SELECT lms_session_state
          FROM desktop_devices
          WHERE user_id = ? AND desktop_device_id = ?
        `)
        .get(input.userId, input.desktopDeviceId);
      if (previousValue === undefined) {
        return null;
      }
      const previous = expectRow(
        previousValue,
        ["lms_session_state"],
        "desktop device heartbeat state",
      );
      const previousLmsSessionState = readText(
        previous,
        "lms_session_state",
      );
      assertLmsSessionState(previousLmsSessionState);

      const updated = this.database
        .prepare(`
          UPDATE desktop_devices
          SET
            last_seen_at_epoch_ms = max(
              COALESCE(last_seen_at_epoch_ms, 0),
              @receivedAtEpochMs
            ),
            lms_session_state = @lmsSessionState,
            app_version = @appVersion
          WHERE user_id = @userId
            AND desktop_device_id = @desktopDeviceId
        `)
        .run(input);
      if (updated.changes !== 1) {
        throw new SqliteDataIntegrityError(
          "Desktop heartbeat update was lost.",
        );
      }
      if (
        input.lmsSessionState === "login-required" &&
        previousLmsSessionState !== "login-required"
      ) {
        onLoginRequiredTransition?.();
      }
      const value = this.database
        .prepare(`
          SELECT ${DEVICE_COLUMNS}
          FROM desktop_devices
          WHERE user_id = ? AND desktop_device_id = ?
        `)
        .get(input.userId, input.desktopDeviceId);
      return mapDesktopDevice(value);
    });
    return record.immediate();
  }

  async getDesktopDevice(
    userId: string,
    desktopDeviceId: string,
  ): Promise<DesktopDeviceRecord | null> {
    assertIdentifier(userId, "user ID");
    assertIdentifier(desktopDeviceId, "desktop device ID");
    const row = this.database
      .prepare(`
        SELECT ${DEVICE_COLUMNS}
        FROM desktop_devices
        WHERE user_id = ? AND desktop_device_id = ?
      `)
      .get(userId, desktopDeviceId);
    return row === undefined ? null : mapDesktopDevice(row);
  }

  async listDesktopDevices(
    userId: string,
  ): Promise<readonly DesktopDeviceRecord[]> {
    assertIdentifier(userId, "user ID");
    return this.database
      .prepare(`
        SELECT ${DEVICE_COLUMNS}
        FROM desktop_devices
        WHERE user_id = ?
        ORDER BY
          COALESCE(last_seen_at_epoch_ms, 0) DESC,
          desktop_device_id
      `)
      .all(userId)
      .map(mapDesktopDevice);
  }
}

export class InMemoryDesktopIdentityStore implements DesktopIdentityStore {
  private readonly subjectUsers = new Map<string, string>();
  private readonly devices = new Map<string, DesktopDeviceRecord>();

  async registerVerifiedIdentity(
    input: VerifiedDesktopIdentityInput,
  ): Promise<VerifiedDesktopIdentity> {
    assertIdentifier(input.candidateUserId, "candidate user ID");
    assertIdentifier(input.desktopDeviceId, "desktop device ID");
    assertSubjectSha256(input.subjectSha256);
    assertEpoch(input.verifiedAtEpochMs, "verification time");
    const existingUserId = this.subjectUsers.get(input.subjectSha256);
    const userId = existingUserId ?? input.candidateUserId;
    if (existingUserId === undefined) {
      this.subjectUsers.set(input.subjectSha256, userId);
    }
    const key = deviceKey(userId, input.desktopDeviceId);
    const existing = this.devices.get(key);
    this.devices.set(key, {
      userId,
      desktopDeviceId: input.desktopDeviceId,
      registeredAtEpochMs:
        existing?.registeredAtEpochMs ?? input.verifiedAtEpochMs,
      lastVerifiedAtEpochMs: Math.max(
        existing?.lastVerifiedAtEpochMs ?? 0,
        input.verifiedAtEpochMs,
      ),
      lastSeenAtEpochMs: Math.max(
        existing?.lastSeenAtEpochMs ?? 0,
        input.verifiedAtEpochMs,
      ),
      lmsSessionState: "connected",
      appVersion: existing?.appVersion ?? null,
    });
    return {
      userId,
      desktopDeviceId: input.desktopDeviceId,
      createdUser: existingUserId === undefined,
    };
  }

  async recordHeartbeat(
    input: {
      readonly userId: string;
      readonly desktopDeviceId: string;
      readonly receivedAtEpochMs: number;
      readonly lmsSessionState: DesktopLmsSessionState;
      readonly appVersion: string | null;
    },
    onLoginRequiredTransition?: () => void,
  ): Promise<DesktopDeviceRecord | null> {
    assertIdentifier(input.userId, "user ID");
    assertIdentifier(input.desktopDeviceId, "desktop device ID");
    assertEpoch(input.receivedAtEpochMs, "heartbeat time");
    assertLmsSessionState(input.lmsSessionState);
    assertAppVersion(input.appVersion);
    const key = deviceKey(input.userId, input.desktopDeviceId);
    const existing = this.devices.get(key);
    if (existing === undefined) {
      return null;
    }
    const updated: DesktopDeviceRecord = {
      ...existing,
      lastSeenAtEpochMs: Math.max(
        existing.lastSeenAtEpochMs ?? 0,
        input.receivedAtEpochMs,
      ),
      lmsSessionState: input.lmsSessionState,
      appVersion: input.appVersion,
    };
    if (
      input.lmsSessionState === "login-required" &&
      existing.lmsSessionState !== "login-required"
    ) {
      onLoginRequiredTransition?.();
    }
    this.devices.set(key, updated);
    return { ...updated };
  }

  async getDesktopDevice(
    userId: string,
    desktopDeviceId: string,
  ): Promise<DesktopDeviceRecord | null> {
    const record = this.devices.get(deviceKey(userId, desktopDeviceId));
    return record === undefined ? null : { ...record };
  }

  async listDesktopDevices(
    userId: string,
  ): Promise<readonly DesktopDeviceRecord[]> {
    return [...this.devices.values()]
      .filter((device) => device.userId === userId)
      .sort(
        (left, right) =>
          (right.lastSeenAtEpochMs ?? 0) -
            (left.lastSeenAtEpochMs ?? 0) ||
          left.desktopDeviceId.localeCompare(right.desktopDeviceId),
      )
      .map((device) => ({ ...device }));
  }
}

function mapDesktopDevice(value: unknown): DesktopDeviceRecord {
  const row = expectRow(value, DEVICE_KEYS, "desktop device");
  const lmsSessionState = readText(row, "lms_session_state");
  assertLmsSessionState(lmsSessionState);
  const record: DesktopDeviceRecord = {
    userId: readText(row, "user_id"),
    desktopDeviceId: readText(row, "desktop_device_id"),
    registeredAtEpochMs: readInteger(row, "registered_at_epoch_ms"),
    lastVerifiedAtEpochMs: readInteger(
      row,
      "last_verified_at_epoch_ms",
    ),
    lastSeenAtEpochMs: readNullableInteger(row, "last_seen_at_epoch_ms"),
    lmsSessionState,
    appVersion: readNullableText(row, "app_version"),
  };
  if (
    record.lastVerifiedAtEpochMs < record.registeredAtEpochMs ||
    (record.lastSeenAtEpochMs !== null &&
      record.lastSeenAtEpochMs < record.registeredAtEpochMs)
  ) {
    throw new SqliteDataIntegrityError(
      "Desktop device lifecycle is invalid.",
    );
  }
  return record;
}

function deviceKey(userId: string, desktopDeviceId: string): string {
  return `${userId}\u0000${desktopDeviceId}`;
}

function assertIdentifier(value: string, label: string): void {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 128 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new SqliteDataIntegrityError(`${label} is invalid.`);
  }
}

function assertSubjectSha256(value: string): void {
  if (!/^[0-9a-f]{64}$/u.test(value)) {
    throw new SqliteDataIntegrityError(
      "External identity SHA-256 is invalid.",
    );
  }
}

function assertEpoch(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new SqliteDataIntegrityError(`${label} is invalid.`);
  }
}

function assertLmsSessionState(
  value: string,
): asserts value is DesktopLmsSessionState {
  if (!(DESKTOP_LMS_SESSION_STATES as readonly string[]).includes(value)) {
    throw new SqliteDataIntegrityError(
      "Desktop LMS session state is invalid.",
    );
  }
}

function assertAppVersion(value: string | null): void {
  if (
    value !== null &&
    (value.length < 1 ||
      value.length > 64 ||
      value.trim() !== value ||
      /[\u0000-\u001f\u007f]/u.test(value))
  ) {
    throw new SqliteDataIntegrityError("Desktop app version is invalid.");
  }
}
