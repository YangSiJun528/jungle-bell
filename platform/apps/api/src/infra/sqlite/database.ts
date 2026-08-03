import Database from "better-sqlite3";

import {
  CAMPUS_SQL_SCHEMA,
  LAUNDRY_LIFECYCLE_SQL_SCHEMA,
} from "../../campus/repository.js";
import { NOTIFICATION_SQL_SCHEMA } from "../../notifications/repository.js";
import { DEFAULT_DEVICE_SESSION_TTL_MS } from "../../domain/pairing.js";

/**
 * The platform rewrite intentionally starts with a new schema. There is no
 * production user data to migrate, and LMS credentials must not survive in
 * any database created by this version.
 */
export const LATEST_SQLITE_SCHEMA_VERSION = 5;
export const SQLITE_BUSY_TIMEOUT_MS = 5_000;
export const SQLITE_WAL_AUTOCHECKPOINT_PAGES = 1_000;

export type SqliteDatabase = Database.Database;

export function openSqliteDatabase(filename: string): SqliteDatabase {
  const database = new Database(filename, {
    timeout: SQLITE_BUSY_TIMEOUT_MS,
  });

  try {
    configureSqliteDatabase(database);
    migrateSqliteDatabase(database);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

export function configureSqliteDatabase(database: SqliteDatabase): void {
  database.pragma("foreign_keys = ON");
  if (database.pragma("foreign_keys", { simple: true }) !== 1) {
    throw new Error("SQLite foreign-key enforcement is unavailable.");
  }
  if (!database.memory) {
    const journalMode = database.pragma("journal_mode = WAL", {
      simple: true,
    });
    if (journalMode !== "wal") {
      throw new Error("SQLite WAL journal mode is unavailable.");
    }
  }
  database.pragma("synchronous = FULL");
  if (database.pragma("synchronous", { simple: true }) !== 2) {
    throw new Error("SQLite FULL synchronous mode is unavailable.");
  }
  database.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
  if (
    database.pragma("busy_timeout", { simple: true }) !==
    SQLITE_BUSY_TIMEOUT_MS
  ) {
    throw new Error("SQLite busy timeout was not applied.");
  }
  database.pragma(
    `wal_autocheckpoint = ${SQLITE_WAL_AUTOCHECKPOINT_PAGES}`,
  );
  if (
    database.pragma("wal_autocheckpoint", { simple: true }) !==
    SQLITE_WAL_AUTOCHECKPOINT_PAGES
  ) {
    throw new Error("SQLite WAL autocheckpoint was not applied.");
  }
  database.defaultSafeIntegers(false);
}

export function migrateSqliteDatabase(database: SqliteDatabase): void {
  const migrate = database.transaction(() => {
    const currentVersion = readPragmaInteger(database, "user_version");
    if (currentVersion > LATEST_SQLITE_SCHEMA_VERSION) {
      throw new Error(
        `SQLite schema version ${currentVersion} is newer than supported version ${LATEST_SQLITE_SCHEMA_VERSION}.`,
      );
    }
    if (currentVersion === 0) {
      database.exec(SCHEMA_VERSION_1);
      database.exec(CAMPUS_SQL_SCHEMA);
      database.exec(NOTIFICATION_SQL_SCHEMA);
      database.pragma(`user_version = ${LATEST_SQLITE_SCHEMA_VERSION}`);
    } else {
      if (currentVersion === 1) {
        migratePairingSchemaToVersion2(database);
      }
      if (currentVersion <= 2) {
        migrateLaundryLifecycleSchemaToVersion3(database);
      }
      if (currentVersion <= 3) {
        migrateDeviceSessionSchemaToVersion4(database);
      }
      if (currentVersion <= 4) {
        migrateIdentityHashSchemaToVersion5(database);
      }
      database.pragma(`user_version = ${LATEST_SQLITE_SCHEMA_VERSION}`);
    }
    assertCurrentSchema(database);
  });
  migrate.immediate();
}

function assertCurrentSchema(database: SqliteDatabase): void {
  const tables = new Set(
    database
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_schema WHERE type = 'table'",
      )
      .all()
      .map(({ name }) => name),
  );
  const required = [
    "users",
    "external_identities",
    "desktop_devices",
    "desktop_sessions",
    "device_sessions",
    "attendance_snapshots",
    "campus_public_snapshots",
    "user_attendance_rules",
    "laundry_queue_claims",
    "notification_events",
  ];
  if (
    tables.has("lms_sessions") ||
    tables.has("attendance_collector_runs") ||
    required.some((table) => !tables.has(table))
  ) {
    throw new Error(
      "SQLITE_SCHEMA_RESET_REQUIRED: this rewrite does not migrate the stage-0 credential database.",
    );
  }
  const challengeColumns = tableColumns(
    database,
    "pairing_challenges",
  );
  const sessionColumns = tableColumns(database, "device_sessions");
  const identityColumns = tableColumns(
    database,
    "external_identities",
  );
  if (
    !challengeColumns.has("manual_code_hash") ||
    challengeColumns.has("claimed_public_key") ||
    sessionColumns.has("public_key") ||
    !sessionColumns.has("expires_at_epoch_ms") ||
    !sessionColumns.has("last_seen_at_epoch_ms") ||
    !identityColumns.has("subject_sha256") ||
    !identityColumns.has("hash_version") ||
    identityColumns.has("subject_hmac") ||
    identityColumns.has("hmac_key_version") ||
    !tableColumns(database, "notification_events").has(
      "expires_at_epoch_ms",
    )
  ) {
    throw new Error(
      "SQLITE_SCHEMA_RESET_REQUIRED: pairing schema columns are not current.",
    );
  }
}

function migrateIdentityHashSchemaToVersion5(
  database: SqliteDatabase,
): void {
  const columns = tableColumns(database, "external_identities");
  if (columns.has("subject_sha256") && columns.has("hash_version")) {
    return;
  }
  if (
    !columns.has("subject_hmac") ||
    !columns.has("hmac_key_version")
  ) {
    throw new Error(
      "SQLITE_SCHEMA_RESET_REQUIRED: external identity columns are not current.",
    );
  }
  const identityCount = database
    .prepare<[], { count: number }>(
      "SELECT count(*) AS count FROM external_identities",
    )
    .get()?.count;
  if (identityCount !== 0) {
    throw new Error(
      "SQLITE_SCHEMA_RESET_REQUIRED: keyed LMS identities cannot be converted to LMS ID SHA-256 without the original LMS ID.",
    );
  }
  database.exec(`
    ALTER TABLE external_identities
      RENAME COLUMN subject_hmac TO subject_sha256;
    ALTER TABLE external_identities
      RENAME COLUMN hmac_key_version TO hash_version;
  `);
}

function migrateDeviceSessionSchemaToVersion4(
  database: SqliteDatabase,
): void {
  const columns = tableColumns(database, "device_sessions");
  const hasExpiry = columns.has("expires_at_epoch_ms");
  const hasLastSeen = columns.has("last_seen_at_epoch_ms");
  if (hasExpiry && hasLastSeen) {
    return;
  }
  if (hasExpiry || hasLastSeen) {
    throw new Error(
      "SQLITE_SCHEMA_RESET_REQUIRED: device session activity columns are incomplete.",
    );
  }
  database.exec(`
    ALTER TABLE device_sessions
      ADD COLUMN expires_at_epoch_ms INTEGER;
    ALTER TABLE device_sessions
      ADD COLUMN last_seen_at_epoch_ms INTEGER;
    UPDATE device_sessions
    SET
      expires_at_epoch_ms =
        created_at_epoch_ms + ${DEFAULT_DEVICE_SESSION_TTL_MS},
      last_seen_at_epoch_ms = created_at_epoch_ms;
  `);
}

function migrateLaundryLifecycleSchemaToVersion3(
  database: SqliteDatabase,
): void {
  if (
    !tableColumns(database, "user_laundry_watches").has("status") ||
    !tableColumns(database, "laundry_voluntary_queue").has("status")
  ) {
    throw new Error(
      "SQLITE_SCHEMA_RESET_REQUIRED: laundry lifecycle schema is unavailable.",
    );
  }
  database.exec(LAUNDRY_LIFECYCLE_SQL_SCHEMA);
}

function tableColumns(
  database: SqliteDatabase,
  table: string,
): Set<string> {
  return new Set(
    database
      .prepare<[], { name: string }>(`PRAGMA table_info(${table})`)
      .all()
      .map(({ name }) => name),
  );
}

function migratePairingSchemaToVersion2(
  database: SqliteDatabase,
): void {
  const tables = new Set(
    database
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_schema WHERE type = 'table'",
      )
      .all()
      .map(({ name }) => name),
  );
  const required = [
    "users",
    "desktop_devices",
    "pairing_challenges",
    "device_sessions",
    "notification_preferences",
    "pairing_claim_transports",
    "push_subscriptions",
    "notification_deliveries",
  ];
  if (
    tables.has("lms_sessions") ||
    required.some((table) => !tables.has(table))
  ) {
    throw new Error(
      "SQLITE_SCHEMA_RESET_REQUIRED: schema version 1 is not a platform pairing database.",
    );
  }

  if (
    !tableColumns(database, "notification_events").has(
      "expires_at_epoch_ms",
    )
  ) {
    database.exec(`
      ALTER TABLE notification_events
        ADD COLUMN expires_at_epoch_ms INTEGER;
      UPDATE notification_events
      SET expires_at_epoch_ms =
        occurred_at_epoch_ms + 24 * 60 * 60 * 1000
      WHERE expires_at_epoch_ms IS NULL;
    `);
  }

  database.exec(`
    UPDATE notification_deliveries
    SET
      status = 'cancelled',
      lease_until_epoch_ms = NULL,
      last_error_code = 'PAIRING_SCHEMA_UPGRADE',
      updated_at_epoch_ms = max(updated_at_epoch_ms, created_at_epoch_ms)
    WHERE channel = 'web-push'
      AND status IN ('pending', 'leased', 'retry', 'awaiting_ack');

    DELETE FROM notification_preferences;
    DELETE FROM push_subscriptions;
    DELETE FROM pairing_claim_transports;
    DELETE FROM device_sessions;
    DELETE FROM pairing_challenges;

    DROP TABLE notification_preferences;
    DROP TABLE push_subscriptions;
    DROP TABLE pairing_claim_transports;
    DROP TABLE device_sessions;
    DROP TABLE pairing_challenges;

    ${PAIRING_SCHEMA_VERSION_2}
  `);
}

function readPragmaInteger(
  database: SqliteDatabase,
  pragma: string,
): number {
  const value = database.pragma(pragma, { simple: true });
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new Error(`PRAGMA ${pragma} returned an invalid integer.`);
  }
  return value;
}

const SCHEMA_VERSION_1 = `
  CREATE TABLE users (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
    status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
    created_at_epoch_ms INTEGER NOT NULL CHECK (created_at_epoch_ms >= 0)
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE external_identities (
    provider TEXT NOT NULL CHECK (provider = 'jungle_lms'),
    subject_sha256 TEXT NOT NULL
      CHECK (
        length(subject_sha256) = 64
        AND subject_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
    hash_version INTEGER NOT NULL CHECK (hash_version = 1),
    user_id TEXT NOT NULL
      REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    linked_at_epoch_ms INTEGER NOT NULL CHECK (linked_at_epoch_ms >= 0),
    last_verified_at_epoch_ms INTEGER NOT NULL
      CHECK (last_verified_at_epoch_ms >= linked_at_epoch_ms),
    PRIMARY KEY (provider, subject_sha256),
    UNIQUE (provider, user_id)
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE desktop_devices (
    user_id TEXT NOT NULL
      REFERENCES users(id) ON UPDATE RESTRICT ON DELETE CASCADE,
    desktop_device_id TEXT NOT NULL
      CHECK (length(desktop_device_id) BETWEEN 1 AND 128),
    registered_at_epoch_ms INTEGER NOT NULL
      CHECK (registered_at_epoch_ms >= 0),
    last_verified_at_epoch_ms INTEGER NOT NULL
      CHECK (last_verified_at_epoch_ms >= registered_at_epoch_ms),
    last_seen_at_epoch_ms INTEGER
      CHECK (last_seen_at_epoch_ms >= registered_at_epoch_ms),
    lms_session_state TEXT NOT NULL
      CHECK (lms_session_state IN ('unknown', 'connected', 'login-required')),
    app_version TEXT
      CHECK (
        app_version IS NULL
        OR length(app_version) BETWEEN 1 AND 64
      ),
    PRIMARY KEY (user_id, desktop_device_id)
  ) STRICT, WITHOUT ROWID;

  CREATE INDEX desktop_devices_user_seen_idx
    ON desktop_devices (user_id, last_seen_at_epoch_ms DESC);

  CREATE TABLE pairing_challenges (
    challenge_id TEXT PRIMARY KEY CHECK (length(challenge_id) > 0),
    user_id TEXT NOT NULL,
    desktop_device_id TEXT NOT NULL,
    pairing_code_hash TEXT NOT NULL UNIQUE CHECK (length(pairing_code_hash) > 0),
    manual_code_hash TEXT NOT NULL UNIQUE CHECK (length(manual_code_hash) > 0),
    status TEXT NOT NULL CHECK (status IN ('pending', 'claimed', 'approved')),
    claimed_device_label TEXT,
    claimed_installation_id TEXT
      CHECK (
        claimed_installation_id IS NULL
        OR (
          length(claimed_installation_id) = 37
          AND claimed_installation_id GLOB 'jbmi_[0-9a-f]*'
          AND substr(claimed_installation_id, 6)
            NOT GLOB '*[^0-9a-f]*'
        )
      ),
    created_at_epoch_ms INTEGER NOT NULL CHECK (created_at_epoch_ms >= 0),
    expires_at_epoch_ms INTEGER NOT NULL
      CHECK (expires_at_epoch_ms > created_at_epoch_ms),
    approved_at_epoch_ms INTEGER
      CHECK (
        approved_at_epoch_ms >= created_at_epoch_ms
        AND approved_at_epoch_ms < expires_at_epoch_ms
      ),
    version INTEGER NOT NULL CHECK (version >= 0),
    FOREIGN KEY (user_id, desktop_device_id)
      REFERENCES desktop_devices(user_id, desktop_device_id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CHECK (
      (status = 'pending' AND claimed_device_label IS NULL AND claimed_installation_id IS NULL AND approved_at_epoch_ms IS NULL)
      OR
      (status = 'claimed' AND claimed_device_label IS NOT NULL AND claimed_installation_id IS NOT NULL AND approved_at_epoch_ms IS NULL)
      OR
      (status = 'approved' AND claimed_device_label IS NOT NULL AND claimed_installation_id IS NOT NULL AND approved_at_epoch_ms IS NOT NULL)
    )
  ) STRICT;

  CREATE INDEX pairing_challenges_user_created_idx
    ON pairing_challenges (user_id, created_at_epoch_ms DESC);

  CREATE TABLE device_sessions (
    session_id TEXT PRIMARY KEY CHECK (length(session_id) > 0),
    pairing_challenge_id TEXT NOT NULL UNIQUE
      REFERENCES pairing_challenges(challenge_id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    user_id TEXT NOT NULL
      REFERENCES users(id) ON UPDATE RESTRICT ON DELETE CASCADE,
    device_id TEXT NOT NULL UNIQUE CHECK (length(device_id) > 0),
    device_label TEXT NOT NULL CHECK (length(device_label) > 0),
    installation_id TEXT NOT NULL
      CHECK (
        length(installation_id) = 37
        AND installation_id GLOB 'jbmi_[0-9a-f]*'
        AND substr(installation_id, 6)
          NOT GLOB '*[^0-9a-f]*'
      ),
    token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) > 0),
    scopes_json TEXT NOT NULL
      CHECK (json_valid(scopes_json) AND json_type(scopes_json) = 'array'),
    created_at_epoch_ms INTEGER NOT NULL CHECK (created_at_epoch_ms >= 0),
    expires_at_epoch_ms INTEGER NOT NULL
      CHECK (expires_at_epoch_ms > created_at_epoch_ms),
    last_seen_at_epoch_ms INTEGER NOT NULL
      CHECK (
        last_seen_at_epoch_ms >= created_at_epoch_ms
        AND last_seen_at_epoch_ms < expires_at_epoch_ms
      ),
    revoked_at_epoch_ms INTEGER CHECK (revoked_at_epoch_ms >= created_at_epoch_ms),
    version INTEGER NOT NULL CHECK (version >= 0),
    UNIQUE (user_id, device_id)
  ) STRICT;

  CREATE INDEX device_sessions_user_created_idx
    ON device_sessions (user_id, created_at_epoch_ms DESC);

  CREATE INDEX device_sessions_installation_idx
    ON device_sessions (installation_id, created_at_epoch_ms DESC);

  CREATE TABLE notification_preferences (
    user_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    meal_breakfast INTEGER NOT NULL CHECK (meal_breakfast IN (0, 1)),
    meal_lunch INTEGER NOT NULL CHECK (meal_lunch IN (0, 1)),
    meal_dinner INTEGER NOT NULL CHECK (meal_dinner IN (0, 1)),
    laundry_notify_when_available INTEGER NOT NULL
      CHECK (laundry_notify_when_available IN (0, 1)),
    selected_machine_ids_json TEXT NOT NULL
      CHECK (
        json_valid(selected_machine_ids_json)
        AND json_type(selected_machine_ids_json) = 'array'
      ),
    updated_at_epoch_ms INTEGER NOT NULL CHECK (updated_at_epoch_ms >= 0),
    PRIMARY KEY (user_id, device_id),
    FOREIGN KEY (user_id, device_id)
      REFERENCES device_sessions(user_id, device_id)
      ON UPDATE RESTRICT ON DELETE CASCADE
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE desktop_sessions (
    token_hash TEXT PRIMARY KEY CHECK (length(token_hash) > 0),
    user_id TEXT NOT NULL,
    desktop_device_id TEXT NOT NULL,
    created_at_epoch_ms INTEGER NOT NULL CHECK (created_at_epoch_ms >= 0),
    expires_at_epoch_ms INTEGER NOT NULL
      CHECK (expires_at_epoch_ms > created_at_epoch_ms),
    revoked_at_epoch_ms INTEGER CHECK (revoked_at_epoch_ms >= created_at_epoch_ms),
    version INTEGER NOT NULL CHECK (version >= 0),
    FOREIGN KEY (user_id, desktop_device_id)
      REFERENCES desktop_devices(user_id, desktop_device_id)
      ON UPDATE RESTRICT ON DELETE CASCADE
  ) STRICT, WITHOUT ROWID;

  CREATE INDEX desktop_sessions_user_device_idx
    ON desktop_sessions (user_id, desktop_device_id);

  CREATE TABLE pairing_claim_transports (
    claim_id TEXT PRIMARY KEY CHECK (length(claim_id) > 0),
    challenge_id TEXT NOT NULL UNIQUE
      REFERENCES pairing_challenges(challenge_id) ON DELETE CASCADE,
    receipt_hash TEXT NOT NULL UNIQUE CHECK (length(receipt_hash) > 0),
    approved_session_ciphertext TEXT
      CHECK (
        approved_session_ciphertext IS NULL
        OR length(approved_session_ciphertext) > 0
      ),
    created_at_epoch_ms INTEGER NOT NULL CHECK (created_at_epoch_ms >= 0),
    expires_at_epoch_ms INTEGER NOT NULL CHECK (expires_at_epoch_ms > created_at_epoch_ms),
    delivered_at_epoch_ms INTEGER
      CHECK (
        delivered_at_epoch_ms >= created_at_epoch_ms
        AND delivered_at_epoch_ms < expires_at_epoch_ms
      ),
    version INTEGER NOT NULL CHECK (version >= 0),
    CHECK (
      delivered_at_epoch_ms IS NULL
      OR approved_session_ciphertext IS NOT NULL
    )
  ) STRICT;

  CREATE TABLE push_subscriptions (
    id TEXT PRIMARY KEY CHECK (length(id) > 0),
    user_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    endpoint TEXT NOT NULL UNIQUE CHECK (length(endpoint) > 0),
    expiration_time INTEGER CHECK (expiration_time >= 0),
    auth_key TEXT NOT NULL CHECK (length(auth_key) > 0),
    p256dh_key TEXT NOT NULL CHECK (length(p256dh_key) > 0),
    created_at_epoch_ms INTEGER NOT NULL CHECK (created_at_epoch_ms >= 0),
    updated_at_epoch_ms INTEGER NOT NULL
      CHECK (updated_at_epoch_ms >= created_at_epoch_ms),
    revoked_at_epoch_ms INTEGER CHECK (revoked_at_epoch_ms >= created_at_epoch_ms),
    revoked_reason TEXT
      CHECK (
        revoked_reason IS NULL
        OR revoked_reason IN (
          'push-endpoint-gone',
          'user-unsubscribed',
          'device-revoked',
          'replaced'
        )
      ),
    CHECK (
      (revoked_at_epoch_ms IS NULL AND revoked_reason IS NULL)
      OR
      (revoked_at_epoch_ms IS NOT NULL AND revoked_reason IS NOT NULL)
    ),
    FOREIGN KEY (user_id, device_id)
      REFERENCES device_sessions(user_id, device_id)
      ON UPDATE RESTRICT ON DELETE CASCADE
  ) STRICT;

  CREATE INDEX push_subscriptions_active_user_idx
    ON push_subscriptions (user_id, device_id, updated_at_epoch_ms DESC)
    WHERE revoked_at_epoch_ms IS NULL;

  CREATE UNIQUE INDEX push_subscriptions_one_active_per_device_idx
    ON push_subscriptions (user_id, device_id)
    WHERE revoked_at_epoch_ms IS NULL;

  CREATE TABLE push_delivery_dedupe (
    dedupe_key TEXT PRIMARY KEY CHECK (length(dedupe_key) BETWEEN 1 AND 200),
    state TEXT NOT NULL CHECK (state IN ('pending', 'completed')),
    expires_at_epoch_ms INTEGER NOT NULL CHECK (expires_at_epoch_ms >= 0)
  ) STRICT, WITHOUT ROWID;

  CREATE INDEX push_delivery_dedupe_expiry_idx
    ON push_delivery_dedupe (expires_at_epoch_ms);

  CREATE TABLE attendance_snapshots (
    user_id TEXT PRIMARY KEY
      REFERENCES users(id) ON UPDATE RESTRICT ON DELETE CASCADE,
    source_device_id TEXT NOT NULL,
    attendance_date TEXT NOT NULL
      CHECK (
        length(attendance_date) = 10
        AND attendance_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
        AND date(attendance_date, '+0 days') = attendance_date
      ),
    cohort_id TEXT
      CHECK (
        cohort_id IS NULL
        OR (
          length(cohort_id) BETWEEN 1 AND 128
          AND trim(cohort_id) = cohort_id
        )
      ),
    cohort_status TEXT NOT NULL
      CHECK (cohort_status IN ('active', 'upcoming', 'ended', 'none', 'unknown')),
    cohort_start_date TEXT
      CHECK (
        cohort_start_date IS NULL
        OR (
          length(cohort_start_date) = 10
          AND cohort_start_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
          AND date(cohort_start_date, '+0 days') = cohort_start_date
        )
      ),
    cohort_end_date TEXT
      CHECK (
        cohort_end_date IS NULL
        OR (
          length(cohort_end_date) = 10
          AND cohort_end_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
          AND date(cohort_end_date, '+0 days') = cohort_end_date
        )
      ),
    morning_checked INTEGER NOT NULL CHECK (morning_checked IN (0, 1)),
    evening_checked INTEGER NOT NULL CHECK (evening_checked IN (0, 1)),
    collected_at_epoch_ms INTEGER NOT NULL CHECK (collected_at_epoch_ms >= 0),
    received_at_epoch_ms INTEGER NOT NULL CHECK (received_at_epoch_ms >= 0),
    version INTEGER NOT NULL CHECK (version >= 0),
    FOREIGN KEY (user_id, source_device_id)
      REFERENCES desktop_devices(user_id, desktop_device_id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CHECK (
      cohort_start_date IS NULL
      OR cohort_end_date IS NULL
      OR cohort_start_date <= cohort_end_date
    )
  ) STRICT, WITHOUT ROWID;
`;

const PAIRING_SCHEMA_VERSION_2 = `
  CREATE TABLE pairing_challenges (
    challenge_id TEXT PRIMARY KEY CHECK (length(challenge_id) > 0),
    user_id TEXT NOT NULL,
    desktop_device_id TEXT NOT NULL,
    pairing_code_hash TEXT NOT NULL UNIQUE CHECK (length(pairing_code_hash) > 0),
    manual_code_hash TEXT NOT NULL UNIQUE CHECK (length(manual_code_hash) > 0),
    status TEXT NOT NULL CHECK (status IN ('pending', 'claimed', 'approved')),
    claimed_device_label TEXT,
    claimed_installation_id TEXT
      CHECK (
        claimed_installation_id IS NULL
        OR (
          length(claimed_installation_id) = 37
          AND claimed_installation_id GLOB 'jbmi_[0-9a-f]*'
          AND substr(claimed_installation_id, 6)
            NOT GLOB '*[^0-9a-f]*'
        )
      ),
    created_at_epoch_ms INTEGER NOT NULL CHECK (created_at_epoch_ms >= 0),
    expires_at_epoch_ms INTEGER NOT NULL
      CHECK (expires_at_epoch_ms > created_at_epoch_ms),
    approved_at_epoch_ms INTEGER
      CHECK (
        approved_at_epoch_ms >= created_at_epoch_ms
        AND approved_at_epoch_ms < expires_at_epoch_ms
      ),
    version INTEGER NOT NULL CHECK (version >= 0),
    FOREIGN KEY (user_id, desktop_device_id)
      REFERENCES desktop_devices(user_id, desktop_device_id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CHECK (
      (status = 'pending' AND claimed_device_label IS NULL AND claimed_installation_id IS NULL AND approved_at_epoch_ms IS NULL)
      OR
      (status = 'claimed' AND claimed_device_label IS NOT NULL AND claimed_installation_id IS NOT NULL AND approved_at_epoch_ms IS NULL)
      OR
      (status = 'approved' AND claimed_device_label IS NOT NULL AND claimed_installation_id IS NOT NULL AND approved_at_epoch_ms IS NOT NULL)
    )
  ) STRICT;

  CREATE INDEX pairing_challenges_user_created_idx
    ON pairing_challenges (user_id, created_at_epoch_ms DESC);

  CREATE TABLE device_sessions (
    session_id TEXT PRIMARY KEY CHECK (length(session_id) > 0),
    pairing_challenge_id TEXT NOT NULL UNIQUE
      REFERENCES pairing_challenges(challenge_id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    user_id TEXT NOT NULL
      REFERENCES users(id) ON UPDATE RESTRICT ON DELETE CASCADE,
    device_id TEXT NOT NULL UNIQUE CHECK (length(device_id) > 0),
    device_label TEXT NOT NULL CHECK (length(device_label) > 0),
    installation_id TEXT NOT NULL
      CHECK (
        length(installation_id) = 37
        AND installation_id GLOB 'jbmi_[0-9a-f]*'
        AND substr(installation_id, 6)
          NOT GLOB '*[^0-9a-f]*'
      ),
    token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) > 0),
    scopes_json TEXT NOT NULL
      CHECK (json_valid(scopes_json) AND json_type(scopes_json) = 'array'),
    created_at_epoch_ms INTEGER NOT NULL CHECK (created_at_epoch_ms >= 0),
    expires_at_epoch_ms INTEGER NOT NULL
      CHECK (expires_at_epoch_ms > created_at_epoch_ms),
    last_seen_at_epoch_ms INTEGER NOT NULL
      CHECK (
        last_seen_at_epoch_ms >= created_at_epoch_ms
        AND last_seen_at_epoch_ms < expires_at_epoch_ms
      ),
    revoked_at_epoch_ms INTEGER CHECK (revoked_at_epoch_ms >= created_at_epoch_ms),
    version INTEGER NOT NULL CHECK (version >= 0),
    UNIQUE (user_id, device_id)
  ) STRICT;

  CREATE INDEX device_sessions_user_created_idx
    ON device_sessions (user_id, created_at_epoch_ms DESC);

  CREATE INDEX device_sessions_installation_idx
    ON device_sessions (installation_id, created_at_epoch_ms DESC);

  CREATE TABLE notification_preferences (
    user_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    meal_breakfast INTEGER NOT NULL CHECK (meal_breakfast IN (0, 1)),
    meal_lunch INTEGER NOT NULL CHECK (meal_lunch IN (0, 1)),
    meal_dinner INTEGER NOT NULL CHECK (meal_dinner IN (0, 1)),
    laundry_notify_when_available INTEGER NOT NULL
      CHECK (laundry_notify_when_available IN (0, 1)),
    selected_machine_ids_json TEXT NOT NULL
      CHECK (
        json_valid(selected_machine_ids_json)
        AND json_type(selected_machine_ids_json) = 'array'
      ),
    updated_at_epoch_ms INTEGER NOT NULL CHECK (updated_at_epoch_ms >= 0),
    PRIMARY KEY (user_id, device_id),
    FOREIGN KEY (user_id, device_id)
      REFERENCES device_sessions(user_id, device_id)
      ON UPDATE RESTRICT ON DELETE CASCADE
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE pairing_claim_transports (
    claim_id TEXT PRIMARY KEY CHECK (length(claim_id) > 0),
    challenge_id TEXT NOT NULL UNIQUE
      REFERENCES pairing_challenges(challenge_id) ON DELETE CASCADE,
    receipt_hash TEXT NOT NULL UNIQUE CHECK (length(receipt_hash) > 0),
    approved_session_ciphertext TEXT
      CHECK (
        approved_session_ciphertext IS NULL
        OR length(approved_session_ciphertext) > 0
      ),
    created_at_epoch_ms INTEGER NOT NULL CHECK (created_at_epoch_ms >= 0),
    expires_at_epoch_ms INTEGER NOT NULL CHECK (expires_at_epoch_ms > created_at_epoch_ms),
    delivered_at_epoch_ms INTEGER
      CHECK (
        delivered_at_epoch_ms >= created_at_epoch_ms
        AND delivered_at_epoch_ms < expires_at_epoch_ms
      ),
    version INTEGER NOT NULL CHECK (version >= 0),
    CHECK (
      delivered_at_epoch_ms IS NULL
      OR approved_session_ciphertext IS NOT NULL
    )
  ) STRICT;

  CREATE TABLE push_subscriptions (
    id TEXT PRIMARY KEY CHECK (length(id) > 0),
    user_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    endpoint TEXT NOT NULL UNIQUE CHECK (length(endpoint) > 0),
    expiration_time INTEGER CHECK (expiration_time >= 0),
    auth_key TEXT NOT NULL CHECK (length(auth_key) > 0),
    p256dh_key TEXT NOT NULL CHECK (length(p256dh_key) > 0),
    created_at_epoch_ms INTEGER NOT NULL CHECK (created_at_epoch_ms >= 0),
    updated_at_epoch_ms INTEGER NOT NULL
      CHECK (updated_at_epoch_ms >= created_at_epoch_ms),
    revoked_at_epoch_ms INTEGER CHECK (revoked_at_epoch_ms >= created_at_epoch_ms),
    revoked_reason TEXT
      CHECK (
        revoked_reason IS NULL
        OR revoked_reason IN (
          'push-endpoint-gone',
          'user-unsubscribed',
          'device-revoked',
          'replaced'
        )
      ),
    CHECK (
      (revoked_at_epoch_ms IS NULL AND revoked_reason IS NULL)
      OR
      (revoked_at_epoch_ms IS NOT NULL AND revoked_reason IS NOT NULL)
    ),
    FOREIGN KEY (user_id, device_id)
      REFERENCES device_sessions(user_id, device_id)
      ON UPDATE RESTRICT ON DELETE CASCADE
  ) STRICT;

  CREATE INDEX push_subscriptions_active_user_idx
    ON push_subscriptions (user_id, device_id, updated_at_epoch_ms DESC)
    WHERE revoked_at_epoch_ms IS NULL;

  CREATE UNIQUE INDEX push_subscriptions_one_active_per_device_idx
    ON push_subscriptions (user_id, device_id)
    WHERE revoked_at_epoch_ms IS NULL;
`;
