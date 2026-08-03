import type { SqliteDatabase } from "../infra/sqlite/database.js";
import {
  attendanceRuleSchema,
  campusKindSchema,
  laundryQueueInputSchema,
  laundryWatchInputSchema,
  mealRuleSchema,
  mealsResponseSchema,
  laundryResponseSchema,
  type ApplianceKind,
  type CampusDataByKind,
  type CampusKind,
  type LaundryQueueEntry,
  type LaundryQueueStatus,
  type LaundryWatch,
  type LaundryWatchStatus,
  type PublicCampusSnapshot,
  type UserAttendanceRule,
  type UserMealRule,
} from "./contracts.js";

export const LAUNDRY_QUEUE_TERMINAL_HISTORY_WINDOW_MS =
  24 * 60 * 60 * 1_000;
export const LAUNDRY_QUEUE_TERMINAL_HISTORY_LIMIT = 8;
const LAUNDRY_QUEUE_USER_LIST_LIMIT = 32;

export const LAUNDRY_LIFECYCLE_SQL_SCHEMA = `
  CREATE UNIQUE INDEX IF NOT EXISTS user_laundry_watches_one_active_idx
    ON user_laundry_watches (
      user_id,
      machine_id,
      appliance,
      ifnull(session_id, ''),
      notify_when_available
    )
    WHERE status = 'active';

  CREATE TABLE IF NOT EXISTS laundry_queue_claims (
    queue_entry_id TEXT PRIMARY KEY
      REFERENCES laundry_voluntary_queue(id) ON DELETE CASCADE,
    machine_id TEXT NOT NULL CHECK (length(machine_id) BETWEEN 1 AND 128),
    appliance TEXT NOT NULL CHECK (appliance IN ('washer', 'dryer')),
    claimed_at_epoch_ms INTEGER NOT NULL CHECK (claimed_at_epoch_ms >= 0),
    expires_at_epoch_ms INTEGER NOT NULL
      CHECK (expires_at_epoch_ms > claimed_at_epoch_ms)
  ) STRICT, WITHOUT ROWID;

  CREATE INDEX IF NOT EXISTS laundry_queue_claims_machine_expiry_idx
    ON laundry_queue_claims (
      machine_id,
      appliance,
      expires_at_epoch_ms,
      queue_entry_id
    );
`;

export const CAMPUS_SQL_SCHEMA = `
  CREATE TABLE IF NOT EXISTS campus_public_snapshots (
    kind TEXT PRIMARY KEY CHECK (kind IN ('laundry', 'meals')),
    etag TEXT,
    content_sha256 TEXT NOT NULL
      CHECK (length(content_sha256) = 64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'),
    payload_json TEXT NOT NULL
      CHECK (json_valid(payload_json) AND json_type(payload_json) = 'object'),
    saved_at_epoch_ms INTEGER NOT NULL CHECK (saved_at_epoch_ms >= 0)
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS campus_source_state (
    kind TEXT PRIMARY KEY CHECK (kind IN ('laundry', 'meals')),
    etag TEXT,
    last_attempt_at_epoch_ms INTEGER NOT NULL CHECK (last_attempt_at_epoch_ms >= 0),
    last_success_at_epoch_ms INTEGER CHECK (last_success_at_epoch_ms >= 0),
    next_poll_at_epoch_ms INTEGER NOT NULL CHECK (next_poll_at_epoch_ms >= 0),
    consecutive_failures INTEGER NOT NULL CHECK (consecutive_failures >= 0),
    last_error_code TEXT,
    last_error_message TEXT,
    CHECK (
      (last_error_code IS NULL AND last_error_message IS NULL)
      OR
      (last_error_code IS NOT NULL AND last_error_message IS NOT NULL)
    )
  ) STRICT, WITHOUT ROWID;

  CREATE INDEX IF NOT EXISTS campus_source_state_due_idx
    ON campus_source_state (next_poll_at_epoch_ms, kind);

  CREATE TABLE IF NOT EXISTS user_meal_rules (
    user_id TEXT PRIMARY KEY CHECK (length(user_id) > 0),
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    breakfast INTEGER NOT NULL CHECK (breakfast IN (0, 1)),
    lunch INTEGER NOT NULL CHECK (lunch IN (0, 1)),
    dinner INTEGER NOT NULL CHECK (dinner IN (0, 1)),
    updated_at_epoch_ms INTEGER NOT NULL CHECK (updated_at_epoch_ms >= 0)
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS user_attendance_rules (
    user_id TEXT PRIMARY KEY CHECK (length(user_id) > 0),
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    morning INTEGER NOT NULL CHECK (morning IN (0, 1)),
    evening INTEGER NOT NULL CHECK (evening IN (0, 1)),
    updated_at_epoch_ms INTEGER NOT NULL CHECK (updated_at_epoch_ms >= 0)
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS user_laundry_watches (
    id TEXT PRIMARY KEY CHECK (length(id) > 0),
    user_id TEXT NOT NULL CHECK (length(user_id) > 0),
    machine_id TEXT NOT NULL CHECK (length(machine_id) BETWEEN 1 AND 128),
    appliance TEXT NOT NULL CHECK (appliance IN ('washer', 'dryer')),
    session_id TEXT CHECK (session_id IS NULL OR length(session_id) BETWEEN 1 AND 256),
    notify_before_minutes INTEGER NOT NULL
      CHECK (notify_before_minutes BETWEEN 0 AND 180),
    notify_when_available INTEGER NOT NULL CHECK (notify_when_available IN (0, 1)),
    status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'cancelled')),
    created_at_epoch_ms INTEGER NOT NULL CHECK (created_at_epoch_ms >= 0),
    updated_at_epoch_ms INTEGER NOT NULL
      CHECK (updated_at_epoch_ms >= created_at_epoch_ms)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS user_laundry_watches_user_status_idx
    ON user_laundry_watches (user_id, status, updated_at_epoch_ms DESC);

  CREATE INDEX IF NOT EXISTS user_laundry_watches_machine_active_idx
    ON user_laundry_watches (machine_id, appliance, session_id, user_id)
    WHERE status = 'active';

  CREATE TABLE IF NOT EXISTS laundry_voluntary_queue (
    id TEXT PRIMARY KEY CHECK (length(id) > 0),
    user_id TEXT NOT NULL CHECK (length(user_id) > 0),
    machine_id TEXT CHECK (machine_id IS NULL OR length(machine_id) BETWEEN 1 AND 128),
    appliance TEXT NOT NULL CHECK (appliance IN ('washer', 'dryer')),
    status TEXT NOT NULL CHECK (status IN ('waiting', 'claimed', 'cancelled', 'expired')),
    joined_at_epoch_ms INTEGER NOT NULL CHECK (joined_at_epoch_ms >= 0),
    left_at_epoch_ms INTEGER
      CHECK (left_at_epoch_ms IS NULL OR left_at_epoch_ms >= joined_at_epoch_ms),
    CHECK (
      (status = 'waiting' AND left_at_epoch_ms IS NULL)
      OR
      (status <> 'waiting' AND left_at_epoch_ms IS NOT NULL)
    )
  ) STRICT;

  CREATE INDEX IF NOT EXISTS laundry_voluntary_queue_order_idx
    ON laundry_voluntary_queue (
      appliance,
      machine_id,
      status,
      joined_at_epoch_ms,
      id
    );

  CREATE UNIQUE INDEX IF NOT EXISTS laundry_voluntary_queue_one_wait_per_user_idx
    ON laundry_voluntary_queue (
      user_id,
      appliance,
      ifnull(machine_id, '')
    )
    WHERE status = 'waiting';

  ${LAUNDRY_LIFECYCLE_SQL_SCHEMA}
`;

export interface CampusSourceState {
  readonly kind: CampusKind;
  readonly etag: string | null;
  readonly lastAttemptAtEpochMs: number;
  readonly lastSuccessAtEpochMs: number | null;
  readonly nextPollAtEpochMs: number;
  readonly consecutiveFailures: number;
  readonly lastErrorCode: string | null;
  readonly lastErrorMessage: string | null;
}

interface StoredSnapshot<K extends CampusKind = CampusKind> {
  readonly kind: K;
  readonly etag: string | null;
  readonly contentSha256: string;
  readonly data: CampusDataByKind[K];
  readonly savedAtEpochMs: number;
}

export interface CampusRepository {
  getSourceState(kind: CampusKind): CampusSourceState | null;
  getStoredSnapshot<K extends CampusKind>(
    kind: K,
  ): StoredSnapshot<K> | null;
  readPublicSnapshot<K extends CampusKind>(
    kind: K,
    nowEpochMs: number,
    maxAgeMs: number,
  ): PublicCampusSnapshot<K>;
  saveSuccess<K extends CampusKind>(input: {
    readonly kind: K;
    readonly etag: string | null;
    readonly contentSha256: string;
    readonly data: CampusDataByKind[K];
    readonly checkedAtEpochMs: number;
    readonly nextPollAtEpochMs: number;
  }): void;
  recordNotModified(input: {
    readonly kind: CampusKind;
    readonly etag: string | null;
    readonly checkedAtEpochMs: number;
    readonly nextPollAtEpochMs: number;
  }): void;
  recordFailure(input: {
    readonly kind: CampusKind;
    readonly checkedAtEpochMs: number;
    readonly nextPollAtEpochMs: number;
    readonly errorCode: string;
    readonly errorMessage: string;
  }): void;
  listDueKinds(nowEpochMs: number): CampusKind[];
}

export class CampusUserConflictError extends Error {
  constructor(
    readonly code:
      | "LAUNDRY_WATCH_ALREADY_EXISTS"
      | "LAUNDRY_QUEUE_ALREADY_JOINED",
  ) {
    super(code);
    this.name = "CampusUserConflictError";
  }
}

export class SqliteCampusRepository implements CampusRepository {
  constructor(private readonly database: SqliteDatabase) {}

  getSourceState(kind: CampusKind): CampusSourceState | null {
    campusKindSchema.parse(kind);
    const row = this.database
      .prepare(`
        SELECT
          kind,
          etag,
          last_attempt_at_epoch_ms,
          last_success_at_epoch_ms,
          next_poll_at_epoch_ms,
          consecutive_failures,
          last_error_code,
          last_error_message
        FROM campus_source_state
        WHERE kind = ?
      `)
      .get(kind);
    return row === undefined ? null : mapSourceState(row);
  }

  getStoredSnapshot<K extends CampusKind>(
    kind: K,
  ): StoredSnapshot<K> | null {
    campusKindSchema.parse(kind);
    const row = this.database
      .prepare(`
        SELECT kind, etag, content_sha256, payload_json, saved_at_epoch_ms
        FROM campus_public_snapshots
        WHERE kind = ?
      `)
      .get(kind);
    if (row === undefined) return null;
    return mapStoredSnapshot(row, kind);
  }

  readPublicSnapshot<K extends CampusKind>(
    kind: K,
    nowEpochMs: number,
    maxAgeMs: number,
  ): PublicCampusSnapshot<K> {
    assertEpoch(nowEpochMs, "nowEpochMs");
    assertPositiveInteger(maxAgeMs, "maxAgeMs");
    const snapshot = this.getStoredSnapshot(kind);
    const state = this.getSourceState(kind);
    const lastCheckedAtEpochMs = state?.lastSuccessAtEpochMs ?? null;
    const stale =
      snapshot === null ||
      lastCheckedAtEpochMs === null ||
      state?.lastErrorCode !== null ||
      nowEpochMs - lastCheckedAtEpochMs > maxAgeMs;
    return {
      kind,
      data: snapshot?.data ?? null,
      etag: state?.etag ?? snapshot?.etag ?? null,
      savedAtEpochMs: snapshot?.savedAtEpochMs ?? null,
      lastCheckedAtEpochMs,
      stale,
      lastError: state?.lastErrorMessage ?? null,
    };
  }

  saveSuccess<K extends CampusKind>(input: {
    readonly kind: K;
    readonly etag: string | null;
    readonly contentSha256: string;
    readonly data: CampusDataByKind[K];
    readonly checkedAtEpochMs: number;
    readonly nextPollAtEpochMs: number;
  }): void {
    campusKindSchema.parse(input.kind);
    assertEpoch(input.checkedAtEpochMs, "checkedAtEpochMs");
    assertNextPoll(input.checkedAtEpochMs, input.nextPollAtEpochMs);
    if (!/^[0-9a-f]{64}$/u.test(input.contentSha256)) {
      throw new TypeError("contentSha256 must be lowercase SHA-256.");
    }
    parseCampusData(input.kind, input.data);
    const payloadJson = JSON.stringify(input.data);
    this.database.transaction(() => {
      this.database
        .prepare(`
          INSERT INTO campus_public_snapshots (
            kind, etag, content_sha256, payload_json, saved_at_epoch_ms
          ) VALUES (
            @kind, @etag, @contentSha256, @payloadJson, @checkedAtEpochMs
          )
          ON CONFLICT(kind) DO UPDATE SET
            etag = excluded.etag,
            content_sha256 = excluded.content_sha256,
            payload_json = excluded.payload_json,
            saved_at_epoch_ms = excluded.saved_at_epoch_ms
        `)
        .run({ ...input, payloadJson });
      upsertSourceSuccess(this.database, input);
    })();
  }

  recordNotModified(input: {
    readonly kind: CampusKind;
    readonly etag: string | null;
    readonly checkedAtEpochMs: number;
    readonly nextPollAtEpochMs: number;
  }): void {
    campusKindSchema.parse(input.kind);
    assertEpoch(input.checkedAtEpochMs, "checkedAtEpochMs");
    assertNextPoll(input.checkedAtEpochMs, input.nextPollAtEpochMs);
    if (this.getStoredSnapshot(input.kind) === null) {
      throw new Error("CAMPUS_NOT_MODIFIED_WITHOUT_SNAPSHOT");
    }
    upsertSourceSuccess(this.database, input);
  }

  recordFailure(input: {
    readonly kind: CampusKind;
    readonly checkedAtEpochMs: number;
    readonly nextPollAtEpochMs: number;
    readonly errorCode: string;
    readonly errorMessage: string;
  }): void {
    campusKindSchema.parse(input.kind);
    assertEpoch(input.checkedAtEpochMs, "checkedAtEpochMs");
    assertNextPoll(input.checkedAtEpochMs, input.nextPollAtEpochMs);
    if (
      input.errorCode.length < 1 ||
      input.errorCode.length > 64 ||
      input.errorMessage.length < 1 ||
      input.errorMessage.length > 1_024
    ) {
      throw new TypeError("Campus failure details are invalid.");
    }
    this.database
      .prepare(`
        INSERT INTO campus_source_state (
          kind,
          etag,
          last_attempt_at_epoch_ms,
          last_success_at_epoch_ms,
          next_poll_at_epoch_ms,
          consecutive_failures,
          last_error_code,
          last_error_message
        ) VALUES (
          @kind, NULL, @checkedAtEpochMs, NULL, @nextPollAtEpochMs,
          1, @errorCode, @errorMessage
        )
        ON CONFLICT(kind) DO UPDATE SET
          last_attempt_at_epoch_ms = excluded.last_attempt_at_epoch_ms,
          next_poll_at_epoch_ms = excluded.next_poll_at_epoch_ms,
          consecutive_failures = campus_source_state.consecutive_failures + 1,
          last_error_code = excluded.last_error_code,
          last_error_message = excluded.last_error_message
      `)
      .run(input);
  }

  listDueKinds(nowEpochMs: number): CampusKind[] {
    assertEpoch(nowEpochMs, "nowEpochMs");
    const rows = this.database
      .prepare(`
        SELECT kind
        FROM campus_source_state
        WHERE next_poll_at_epoch_ms <= ?
        ORDER BY next_poll_at_epoch_ms, kind
      `)
      .all(nowEpochMs);
    const due = rows.map((row) =>
      campusKindSchema.parse(asRow(row).kind),
    );
    const initialized = new Set(
      this.database
        .prepare("SELECT kind FROM campus_source_state")
        .all()
        .map((row) => campusKindSchema.parse(asRow(row).kind)),
    );
    for (const kind of ["laundry", "meals"] as const) {
      if (!initialized.has(kind)) due.push(kind);
    }
    return [...new Set(due)];
  }
}

export class SqliteCampusUserRepository {
  constructor(private readonly database: SqliteDatabase) {}

  getMealRule(userId: string): UserMealRule | null {
    assertId(userId, "userId");
    const row = this.database
      .prepare(`
        SELECT
          user_id, enabled, breakfast, lunch, dinner, updated_at_epoch_ms
        FROM user_meal_rules
        WHERE user_id = ?
      `)
      .get(userId);
    return row === undefined ? null : mapMealRule(row);
  }

  upsertMealRule(rule: UserMealRule): void {
    assertId(rule.userId, "userId");
    mealRuleSchema.parse({
      enabled: rule.enabled,
      breakfast: rule.breakfast,
      lunch: rule.lunch,
      dinner: rule.dinner,
    });
    assertEpoch(rule.updatedAtEpochMs, "updatedAtEpochMs");
    this.database
      .prepare(`
        INSERT INTO user_meal_rules (
          user_id, enabled, breakfast, lunch, dinner, updated_at_epoch_ms
        ) VALUES (
          @userId, @enabled, @breakfast, @lunch, @dinner, @updatedAtEpochMs
        )
        ON CONFLICT(user_id) DO UPDATE SET
          enabled = excluded.enabled,
          breakfast = excluded.breakfast,
          lunch = excluded.lunch,
          dinner = excluded.dinner,
          updated_at_epoch_ms = excluded.updated_at_epoch_ms
        WHERE excluded.updated_at_epoch_ms >= user_meal_rules.updated_at_epoch_ms
      `)
      .run({
        ...rule,
        enabled: bool(rule.enabled),
        breakfast: bool(rule.breakfast),
        lunch: bool(rule.lunch),
        dinner: bool(rule.dinner),
      });
  }

  listMealSubscriberUserIds(
    meal: "breakfast" | "lunch" | "dinner",
  ): string[] {
    const column = meal;
    return this.database
      .prepare(`
        SELECT user_id
        FROM user_meal_rules
        WHERE enabled = 1 AND ${column} = 1
        ORDER BY user_id
      `)
      .all()
      .map((row) => readText(asRow(row), "user_id"));
  }

  getAttendanceRule(userId: string): UserAttendanceRule | null {
    assertId(userId, "userId");
    const row = this.database
      .prepare(`
        SELECT
          user_id, enabled, morning, evening, updated_at_epoch_ms
        FROM user_attendance_rules
        WHERE user_id = ?
      `)
      .get(userId);
    return row === undefined ? null : mapAttendanceRule(row);
  }

  upsertAttendanceRule(rule: UserAttendanceRule): void {
    assertId(rule.userId, "userId");
    attendanceRuleSchema.parse({
      enabled: rule.enabled,
      morning: rule.morning,
      evening: rule.evening,
    });
    assertEpoch(rule.updatedAtEpochMs, "updatedAtEpochMs");
    this.database
      .prepare(`
        INSERT INTO user_attendance_rules (
          user_id, enabled, morning, evening, updated_at_epoch_ms
        ) VALUES (
          @userId, @enabled, @morning, @evening, @updatedAtEpochMs
        )
        ON CONFLICT(user_id) DO UPDATE SET
          enabled = excluded.enabled,
          morning = excluded.morning,
          evening = excluded.evening,
          updated_at_epoch_ms = excluded.updated_at_epoch_ms
        WHERE excluded.updated_at_epoch_ms >=
          user_attendance_rules.updated_at_epoch_ms
      `)
      .run({
        ...rule,
        enabled: bool(rule.enabled),
        morning: bool(rule.morning),
        evening: bool(rule.evening),
      });
  }

  isAttendancePhaseEnabled(
    userId: string,
    phase: "morning" | "evening",
  ): boolean {
    const rule = this.getAttendanceRule(userId);
    return (
      rule !== null &&
      rule.enabled &&
      (phase === "morning" ? rule.morning : rule.evening)
    );
  }

  listAttendanceSubscriberUserIds(
    phase: "morning" | "evening",
  ): string[] {
    const column = phase;
    return this.database
      .prepare(`
        SELECT user_id
        FROM user_attendance_rules
        WHERE enabled = 1 AND ${column} = 1
        ORDER BY user_id
      `)
      .all()
      .map((row) => readText(asRow(row), "user_id"));
  }

  createWatch(watch: LaundryWatch): void {
    validateWatch(watch);
    const create = this.database.transaction(() => {
      if (this.hasActiveWatchDuplicate(watch)) {
        throw new CampusUserConflictError(
          "LAUNDRY_WATCH_ALREADY_EXISTS",
        );
      }
      try {
        this.database
          .prepare(`
            INSERT INTO user_laundry_watches (
              id,
              user_id,
              machine_id,
              appliance,
              session_id,
              notify_before_minutes,
              notify_when_available,
              status,
              created_at_epoch_ms,
              updated_at_epoch_ms
            ) VALUES (
              @id,
              @userId,
              @machineId,
              @appliance,
              @sessionId,
              @notifyBeforeMinutes,
              @notifyWhenAvailable,
              @status,
              @createdAtEpochMs,
              @updatedAtEpochMs
            )
          `)
          .run({
            ...watch,
            notifyWhenAvailable: bool(watch.notifyWhenAvailable),
          });
      } catch (error) {
        if (this.hasActiveWatchDuplicate(watch)) {
          throw new CampusUserConflictError(
            "LAUNDRY_WATCH_ALREADY_EXISTS",
          );
        }
        throw error;
      }
    });
    create.immediate();
  }

  listWatchesByUser(userId: string): LaundryWatch[] {
    assertId(userId, "userId");
    return this.database
      .prepare(`
        SELECT
          id,
          user_id,
          machine_id,
          appliance,
          session_id,
          notify_before_minutes,
          notify_when_available,
          status,
          created_at_epoch_ms,
          updated_at_epoch_ms
        FROM user_laundry_watches
        WHERE user_id = ?
        ORDER BY created_at_epoch_ms DESC, id
        LIMIT 128
      `)
      .all(userId)
      .map(mapWatch);
  }

  listActiveWatches(input: {
    readonly machineId: string;
    readonly appliance: ApplianceKind;
    readonly sessionId?: string | null;
  }): LaundryWatch[] {
    laundryWatchInputSchema
      .pick({ machineId: true, appliance: true })
      .parse({
        machineId: input.machineId,
        appliance: input.appliance,
      });
    const query =
      input.sessionId === undefined
        ? `
          SELECT ${WATCH_COLUMNS}
          FROM user_laundry_watches
          WHERE status = 'active'
            AND machine_id = @machineId
            AND appliance = @appliance
          ORDER BY user_id, id
        `
        : `
          SELECT ${WATCH_COLUMNS}
          FROM user_laundry_watches
          WHERE status = 'active'
            AND machine_id = @machineId
            AND appliance = @appliance
            AND (session_id IS NULL OR session_id = @sessionId)
          ORDER BY user_id, id
        `;
    return this.database.prepare(query).all(input).map(mapWatch);
  }

  setWatchStatus(
    id: string,
    userId: string,
    status: Exclude<LaundryWatchStatus, "active">,
    atEpochMs: number,
  ): boolean {
    assertId(id, "id");
    assertId(userId, "userId");
    assertEpoch(atEpochMs, "atEpochMs");
    const result = this.database
      .prepare(`
        UPDATE user_laundry_watches
        SET status = @status, updated_at_epoch_ms = @atEpochMs
        WHERE id = @id
          AND user_id = @userId
          AND status = 'active'
          AND created_at_epoch_ms <= @atEpochMs
      `)
      .run({ id, userId, status, atEpochMs });
    return result.changes === 1;
  }

  completeActiveWatches(
    ids: readonly string[],
    atEpochMs: number,
  ): number {
    assertEpoch(atEpochMs, "atEpochMs");
    if (ids.length === 0) return 0;
    for (const id of ids) assertId(id, "watchId");
    const placeholders = ids.map(() => "?").join(", ");
    const result = this.database
      .prepare(`
        UPDATE user_laundry_watches
        SET status = 'completed', updated_at_epoch_ms = ?
        WHERE id IN (${placeholders})
          AND status = 'active'
          AND created_at_epoch_ms <= ?
      `)
      .run(atEpochMs, ...ids, atEpochMs);
    return result.changes;
  }

  enqueue(entry: Omit<LaundryQueueEntry, "position">): LaundryQueueEntry {
    validateQueueEntry({ ...entry, position: 1 });
    if (entry.status !== "waiting" || entry.leftAtEpochMs !== null) {
      throw new TypeError("A new voluntary queue entry must be waiting.");
    }
    const insertAndRead = this.database.transaction(() => {
      if (this.hasQueueConflict(entry)) {
        throw new CampusUserConflictError(
          "LAUNDRY_QUEUE_ALREADY_JOINED",
        );
      }
      try {
        this.database
          .prepare(`
            INSERT INTO laundry_voluntary_queue (
              id, user_id, machine_id, appliance, status,
              joined_at_epoch_ms, left_at_epoch_ms
            ) VALUES (
              @id, @userId, @machineId, @appliance, @status,
              @joinedAtEpochMs, @leftAtEpochMs
            )
          `)
          .run(entry);
      } catch (error) {
        if (this.hasQueueConflict(entry)) {
          throw new CampusUserConflictError(
            "LAUNDRY_QUEUE_ALREADY_JOINED",
          );
        }
        throw error;
      }
      return this.getQueueEntry(entry.id);
    });
    const created = insertAndRead();
    if (created === null) throw new Error("QUEUE_INSERT_LOST");
    return created;
  }

  getQueueEntry(id: string): LaundryQueueEntry | null {
    assertId(id, "id");
    const row = this.database
      .prepare(`
        SELECT
          q.id,
          q.user_id,
          q.machine_id,
          q.appliance,
          q.status,
          q.joined_at_epoch_ms,
          q.left_at_epoch_ms,
          CASE
            WHEN q.status <> 'waiting' THEN 0
            ELSE (
              SELECT count(*)
              FROM laundry_voluntary_queue preceding
              WHERE preceding.status = 'waiting'
                AND preceding.appliance = q.appliance
                AND preceding.machine_id IS q.machine_id
                AND (
                  preceding.joined_at_epoch_ms < q.joined_at_epoch_ms
                  OR (
                    preceding.joined_at_epoch_ms = q.joined_at_epoch_ms
                    AND preceding.id <= q.id
                  )
                )
            )
          END AS position
        FROM laundry_voluntary_queue q
        WHERE q.id = ?
      `)
      .get(id);
    return row === undefined ? null : mapQueueEntry(row);
  }

  listQueue(input: {
    readonly appliance: ApplianceKind;
    readonly machineId: string | null;
  }): LaundryQueueEntry[] {
    laundryQueueInputSchema.parse(input);
    return this.database
      .prepare(`
        SELECT
          q.id,
          q.user_id,
          q.machine_id,
          q.appliance,
          q.status,
          q.joined_at_epoch_ms,
          q.left_at_epoch_ms,
          row_number() OVER (
            ORDER BY q.joined_at_epoch_ms, q.id
          ) AS position
        FROM laundry_voluntary_queue q
        WHERE q.status = 'waiting'
          AND q.appliance = @appliance
          AND q.machine_id IS @machineId
        ORDER BY q.joined_at_epoch_ms, q.id
      `)
      .all(input)
      .map(mapQueueEntry);
  }

  listQueueByUser(
    userId: string,
    nowEpochMs: number,
  ): LaundryQueueEntry[] {
    assertId(userId, "userId");
    assertEpoch(nowEpochMs, "nowEpochMs");
    const waiting = this.database
      .prepare(`
        SELECT
          q.id,
          q.user_id,
          q.machine_id,
          q.appliance,
          q.status,
          q.joined_at_epoch_ms,
          q.left_at_epoch_ms,
          (
            SELECT count(*)
            FROM laundry_voluntary_queue preceding
            WHERE preceding.status = 'waiting'
              AND preceding.appliance = q.appliance
              AND preceding.machine_id IS q.machine_id
              AND (
                preceding.joined_at_epoch_ms < q.joined_at_epoch_ms
                OR (
                  preceding.joined_at_epoch_ms = q.joined_at_epoch_ms
                  AND preceding.id <= q.id
                )
              )
          ) AS position
        FROM laundry_voluntary_queue q
        WHERE q.user_id = ?
          AND q.status = 'waiting'
        ORDER BY q.joined_at_epoch_ms DESC, q.id
        LIMIT ${LAUNDRY_QUEUE_USER_LIST_LIMIT}
      `)
      .all(userId)
      .map(mapQueueEntry);
    const terminalLimit = Math.min(
      LAUNDRY_QUEUE_TERMINAL_HISTORY_LIMIT,
      LAUNDRY_QUEUE_USER_LIST_LIMIT - waiting.length,
    );
    if (terminalLimit === 0) return waiting;

    const terminalSinceEpochMs = Math.max(
      0,
      nowEpochMs - LAUNDRY_QUEUE_TERMINAL_HISTORY_WINDOW_MS,
    );
    const recentTerminal = this.database
      .prepare(`
        SELECT
          q.id,
          q.user_id,
          q.machine_id,
          q.appliance,
          q.status,
          q.joined_at_epoch_ms,
          q.left_at_epoch_ms,
          0 AS position
        FROM laundry_voluntary_queue q
        WHERE q.user_id = @userId
          AND q.status IN ('claimed', 'expired')
          AND q.left_at_epoch_ms >= @terminalSinceEpochMs
          AND q.left_at_epoch_ms <= @nowEpochMs
        ORDER BY q.left_at_epoch_ms DESC, q.id DESC
        LIMIT @terminalLimit
      `)
      .all({
        userId,
        nowEpochMs,
        terminalSinceEpochMs,
        terminalLimit,
      })
      .map(mapQueueEntry);
    return [...waiting, ...recentTerminal];
  }

  leaveQueue(
    id: string,
    userId: string,
    status: Exclude<LaundryQueueStatus, "waiting">,
    atEpochMs: number,
  ): boolean {
    assertId(id, "id");
    assertId(userId, "userId");
    assertEpoch(atEpochMs, "atEpochMs");
    const result = this.database
      .prepare(`
        UPDATE laundry_voluntary_queue
        SET status = @status, left_at_epoch_ms = @atEpochMs
        WHERE id = @id
          AND user_id = @userId
          AND status = 'waiting'
          AND joined_at_epoch_ms <= @atEpochMs
      `)
      .run({ id, userId, status, atEpochMs });
    return result.changes === 1;
  }

  findWaitingQueueHead(input: {
    readonly appliance: ApplianceKind;
    readonly machineId: string | null;
  }): LaundryQueueEntry | null {
    laundryQueueInputSchema.parse(input);
    const row = this.database
      .prepare(`
        SELECT
          id,
          user_id,
          machine_id,
          appliance,
          status,
          joined_at_epoch_ms,
          left_at_epoch_ms,
          1 AS position
        FROM laundry_voluntary_queue
        WHERE status = 'waiting'
          AND appliance = @appliance
          AND (machine_id IS NULL OR machine_id IS @machineId)
        ORDER BY joined_at_epoch_ms, id
        LIMIT 1
      `)
      .get(input);
    return row === undefined ? null : mapQueueEntry(row);
  }

  claimWaitingQueueHead(input: {
    readonly appliance: ApplianceKind;
    readonly machineId: string;
    readonly claimedAtEpochMs: number;
    readonly expiresAtEpochMs: number;
  }): LaundryQueueEntry | null {
    laundryQueueInputSchema.parse({
      appliance: input.appliance,
      machineId: input.machineId,
    });
    assertEpoch(input.claimedAtEpochMs, "claimedAtEpochMs");
    assertEpoch(input.expiresAtEpochMs, "expiresAtEpochMs");
    if (input.expiresAtEpochMs <= input.claimedAtEpochMs) {
      throw new TypeError(
        "Queue claim expiry must be after its claim time.",
      );
    }
    const claim = this.database.transaction(() => {
      const activeClaim = this.database
        .prepare(`
          SELECT 1
          FROM laundry_queue_claims c
          JOIN laundry_voluntary_queue q
            ON q.id = c.queue_entry_id
          WHERE q.status = 'claimed'
            AND c.machine_id = @machineId
            AND c.appliance = @appliance
            AND c.expires_at_epoch_ms > @claimedAtEpochMs
          LIMIT 1
        `)
        .get(input);
      if (activeClaim !== undefined) return null;

      const head = this.findWaitingQueueHead({
        machineId: input.machineId,
        appliance: input.appliance,
      });
      if (head === null) return null;
      const updated = this.database
        .prepare(`
          UPDATE laundry_voluntary_queue
          SET status = 'claimed', left_at_epoch_ms = @claimedAtEpochMs
          WHERE id = @id AND status = 'waiting'
        `)
        .run({
          id: head.id,
          claimedAtEpochMs: input.claimedAtEpochMs,
        });
      if (updated.changes !== 1) return null;
      this.database
        .prepare(`
          INSERT INTO laundry_queue_claims (
            queue_entry_id,
            machine_id,
            appliance,
            claimed_at_epoch_ms,
            expires_at_epoch_ms
          ) VALUES (
            @id,
            @machineId,
            @appliance,
            @claimedAtEpochMs,
            @expiresAtEpochMs
          )
        `)
        .run({ ...input, id: head.id });
      return this.getQueueEntry(head.id);
    });
    return claim.immediate();
  }

  expireQueueClaims(nowEpochMs: number): number {
    assertEpoch(nowEpochMs, "nowEpochMs");
    const result = this.database
      .prepare(`
        UPDATE laundry_voluntary_queue
        SET status = 'expired'
        WHERE status = 'claimed'
          AND id IN (
            SELECT queue_entry_id
            FROM laundry_queue_claims
            WHERE expires_at_epoch_ms <= @nowEpochMs
          )
      `)
      .run({ nowEpochMs });
    return result.changes;
  }

  private hasActiveWatchDuplicate(
    watch: LaundryWatch,
  ): boolean {
    return (
      this.database
        .prepare(`
          SELECT 1
          FROM user_laundry_watches
          WHERE user_id = @userId
            AND machine_id = @machineId
            AND appliance = @appliance
            AND session_id IS @sessionId
            AND notify_when_available = @notifyWhenAvailable
            AND status = 'active'
          LIMIT 1
        `)
        .get({
          ...watch,
          notifyWhenAvailable: bool(watch.notifyWhenAvailable),
        }) !== undefined
    );
  }

  private hasQueueConflict(
    entry: Omit<LaundryQueueEntry, "position">,
  ): boolean {
    return (
      this.database
        .prepare(`
          SELECT 1
          FROM laundry_voluntary_queue q
          LEFT JOIN laundry_queue_claims c
            ON c.queue_entry_id = q.id
          WHERE q.user_id = @userId
            AND q.appliance = @appliance
            AND q.machine_id IS @machineId
            AND (
              q.status = 'waiting'
              OR (
                q.status = 'claimed'
                AND c.expires_at_epoch_ms > @joinedAtEpochMs
              )
            )
          LIMIT 1
        `)
        .get(entry) !== undefined
    );
  }
}

const WATCH_COLUMNS = `
  id,
  user_id,
  machine_id,
  appliance,
  session_id,
  notify_before_minutes,
  notify_when_available,
  status,
  created_at_epoch_ms,
  updated_at_epoch_ms
`;

function upsertSourceSuccess(
  database: SqliteDatabase,
  input: {
    readonly kind: CampusKind;
    readonly etag: string | null;
    readonly checkedAtEpochMs: number;
    readonly nextPollAtEpochMs: number;
  },
): void {
  database
    .prepare(`
      INSERT INTO campus_source_state (
        kind,
        etag,
        last_attempt_at_epoch_ms,
        last_success_at_epoch_ms,
        next_poll_at_epoch_ms,
        consecutive_failures,
        last_error_code,
        last_error_message
      ) VALUES (
        @kind, @etag, @checkedAtEpochMs, @checkedAtEpochMs,
        @nextPollAtEpochMs, 0, NULL, NULL
      )
      ON CONFLICT(kind) DO UPDATE SET
        etag = coalesce(excluded.etag, campus_source_state.etag),
        last_attempt_at_epoch_ms = excluded.last_attempt_at_epoch_ms,
        last_success_at_epoch_ms = excluded.last_success_at_epoch_ms,
        next_poll_at_epoch_ms = excluded.next_poll_at_epoch_ms,
        consecutive_failures = 0,
        last_error_code = NULL,
        last_error_message = NULL
    `)
    .run(input);
}

function mapSourceState(value: unknown): CampusSourceState {
  const row = asRow(value);
  return {
    kind: campusKindSchema.parse(row.kind),
    etag: nullableText(row, "etag"),
    lastAttemptAtEpochMs: integer(row, "last_attempt_at_epoch_ms"),
    lastSuccessAtEpochMs: nullableInteger(
      row,
      "last_success_at_epoch_ms",
    ),
    nextPollAtEpochMs: integer(row, "next_poll_at_epoch_ms"),
    consecutiveFailures: integer(row, "consecutive_failures"),
    lastErrorCode: nullableText(row, "last_error_code"),
    lastErrorMessage: nullableText(row, "last_error_message"),
  };
}

function mapStoredSnapshot<K extends CampusKind>(
  value: unknown,
  expectedKind: K,
): StoredSnapshot<K> {
  const row = asRow(value);
  const kind = campusKindSchema.parse(row.kind);
  if (kind !== expectedKind) throw new Error("CAMPUS_KIND_MISMATCH");
  const parsedJson: unknown = JSON.parse(readText(row, "payload_json"));
  return {
    kind: expectedKind,
    etag: nullableText(row, "etag"),
    contentSha256: readText(row, "content_sha256"),
    data: parseCampusData(expectedKind, parsedJson),
    savedAtEpochMs: integer(row, "saved_at_epoch_ms"),
  };
}

function parseCampusData<K extends CampusKind>(
  kind: K,
  value: unknown,
): CampusDataByKind[K] {
  return (kind === "laundry"
    ? laundryResponseSchema.parse(value)
    : mealsResponseSchema.parse(value)) as CampusDataByKind[K];
}

function mapMealRule(value: unknown): UserMealRule {
  const row = asRow(value);
  return {
    userId: readText(row, "user_id"),
    enabled: boolean(row, "enabled"),
    breakfast: boolean(row, "breakfast"),
    lunch: boolean(row, "lunch"),
    dinner: boolean(row, "dinner"),
    updatedAtEpochMs: integer(row, "updated_at_epoch_ms"),
  };
}

function mapAttendanceRule(value: unknown): UserAttendanceRule {
  const row = asRow(value);
  return {
    userId: readText(row, "user_id"),
    enabled: boolean(row, "enabled"),
    morning: boolean(row, "morning"),
    evening: boolean(row, "evening"),
    updatedAtEpochMs: integer(row, "updated_at_epoch_ms"),
  };
}

function validateWatch(watch: LaundryWatch): void {
  assertId(watch.id, "id");
  assertId(watch.userId, "userId");
  laundryWatchInputSchema.parse({
    machineId: watch.machineId,
    appliance: watch.appliance,
    sessionId: watch.sessionId,
    notifyBeforeMinutes: watch.notifyBeforeMinutes,
    notifyWhenAvailable: watch.notifyWhenAvailable,
  });
  if (!["active", "completed", "cancelled"].includes(watch.status)) {
    throw new TypeError("Invalid laundry watch status.");
  }
  assertEpoch(watch.createdAtEpochMs, "createdAtEpochMs");
  assertEpoch(watch.updatedAtEpochMs, "updatedAtEpochMs");
  if (watch.updatedAtEpochMs < watch.createdAtEpochMs) {
    throw new TypeError("Laundry watch timestamps are invalid.");
  }
}

function mapWatch(value: unknown): LaundryWatch {
  const row = asRow(value);
  const watch: LaundryWatch = {
    id: readText(row, "id"),
    userId: readText(row, "user_id"),
    machineId: readText(row, "machine_id"),
    appliance: appliance(row, "appliance"),
    sessionId: nullableText(row, "session_id"),
    notifyBeforeMinutes: integer(row, "notify_before_minutes"),
    notifyWhenAvailable: boolean(row, "notify_when_available"),
    status: laundryWatchStatus(row.status),
    createdAtEpochMs: integer(row, "created_at_epoch_ms"),
    updatedAtEpochMs: integer(row, "updated_at_epoch_ms"),
  };
  validateWatch(watch);
  return watch;
}

function validateQueueEntry(entry: LaundryQueueEntry): void {
  assertId(entry.id, "id");
  assertId(entry.userId, "userId");
  laundryQueueInputSchema.parse({
    machineId: entry.machineId,
    appliance: entry.appliance,
  });
  laundryQueueStatus(entry.status);
  assertEpoch(entry.joinedAtEpochMs, "joinedAtEpochMs");
  if (entry.leftAtEpochMs !== null) {
    assertEpoch(entry.leftAtEpochMs, "leftAtEpochMs");
  }
  if (
    (entry.status === "waiting") !== (entry.leftAtEpochMs === null) ||
    !Number.isSafeInteger(entry.position) ||
    entry.position < 0
  ) {
    throw new TypeError("Voluntary queue entry is invalid.");
  }
}

function mapQueueEntry(value: unknown): LaundryQueueEntry {
  const row = asRow(value);
  const entry: LaundryQueueEntry = {
    id: readText(row, "id"),
    userId: readText(row, "user_id"),
    machineId: nullableText(row, "machine_id"),
    appliance: appliance(row, "appliance"),
    status: laundryQueueStatus(row.status),
    joinedAtEpochMs: integer(row, "joined_at_epoch_ms"),
    leftAtEpochMs: nullableInteger(row, "left_at_epoch_ms"),
    position: integer(row, "position"),
  };
  validateQueueEntry(entry);
  return entry;
}

function asRow(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("SQLite row was invalid.");
  }
  return value as Record<string, unknown>;
}

function readText(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${key} must be non-empty text.`);
  }
  return value;
}

function nullableText(
  row: Record<string, unknown>,
  key: string,
): string | null {
  return row[key] === null ? null : readText(row, key);
}

function integer(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new TypeError(`${key} must be a non-negative safe integer.`);
  }
  return value;
}

function nullableInteger(
  row: Record<string, unknown>,
  key: string,
): number | null {
  return row[key] === null ? null : integer(row, key);
}

function boolean(row: Record<string, unknown>, key: string): boolean {
  const value = row[key];
  if (value !== 0 && value !== 1) {
    throw new TypeError(`${key} must be a SQLite boolean.`);
  }
  return value === 1;
}

function bool(value: boolean): 0 | 1 {
  return value ? 1 : 0;
}

function appliance(
  row: Record<string, unknown>,
  key: string,
): ApplianceKind {
  const value = readText(row, key);
  if (value !== "washer" && value !== "dryer") {
    throw new TypeError(`${key} is not an appliance kind.`);
  }
  return value;
}

function laundryWatchStatus(value: unknown): LaundryWatchStatus {
  if (
    value !== "active" &&
    value !== "completed" &&
    value !== "cancelled"
  ) {
    throw new TypeError("Invalid laundry watch status.");
  }
  return value;
}

function laundryQueueStatus(value: unknown): LaundryQueueStatus {
  if (
    value !== "waiting" &&
    value !== "claimed" &&
    value !== "cancelled" &&
    value !== "expired"
  ) {
    throw new TypeError("Invalid laundry queue status.");
  }
  return value;
}

function assertId(value: string, name: string): void {
  if (typeof value !== "string" || value.length < 1 || value.length > 256) {
    throw new TypeError(`${name} is invalid.`);
  }
}

function assertEpoch(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer.`);
  }
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
}

function assertNextPoll(atEpochMs: number, nextEpochMs: number): void {
  assertEpoch(nextEpochMs, "nextPollAtEpochMs");
  if (nextEpochMs < atEpochMs) {
    throw new TypeError("nextPollAtEpochMs cannot precede the attempt.");
  }
}
