import type {
  BinaryObject,
  CollectionCommit,
  CollectorStorage,
  LaundryEvent,
  MinuteObservation,
  SourceName,
  SourceState,
} from "../../collector-core/src/types";

interface SourceStateRow {
  source: SourceName;
  last_attempt_at: string;
  last_success_at: string | null;
  last_response_sha: string | null;
  last_raw_key: string | null;
  last_normalized_key: string | null;
  version_first_seen_at: string | null;
  consecutive_failures: number;
  last_error: string | null;
}

interface ObservationRow {
  source: SourceName;
  minute_epoch: number;
  scheduled_at: string;
  collected_at: string;
  status: MinuteObservation["status"];
  version_sha: string | null;
  raw_key: string | null;
  normalized_key: string | null;
  version_first_seen_at: string | null;
  changed: number;
  duration_ms: number;
  http_status: number | null;
  error: string | null;
}

interface EventRow {
  id: string;
  machine_id: string;
  appliance: LaundryEvent["appliance"];
  session_id: string | null;
  type: LaundryEvent["type"];
  previous_observed_at: string | null;
  observed_at: string;
  eta_delta_minutes: number | null;
  previous_state: string | null;
  current_state: string;
  detail_json: string;
}

function toSourceState(row: SourceStateRow): SourceState {
  return {
    source: row.source,
    lastAttemptAt: row.last_attempt_at,
    lastSuccessAt: row.last_success_at,
    lastResponseSha: row.last_response_sha,
    lastRawKey: row.last_raw_key,
    lastNormalizedKey: row.last_normalized_key,
    versionFirstSeenAt: row.version_first_seen_at,
    consecutiveFailures: row.consecutive_failures,
    lastError: row.last_error,
  };
}

function toObservation(row: ObservationRow): MinuteObservation {
  return {
    source: row.source,
    minuteEpoch: row.minute_epoch,
    scheduledAt: row.scheduled_at,
    collectedAt: row.collected_at,
    status: row.status,
    versionSha: row.version_sha,
    rawKey: row.raw_key,
    normalizedKey: row.normalized_key,
    versionFirstSeenAt: row.version_first_seen_at,
    changed: row.changed === 1,
    durationMs: row.duration_ms,
    httpStatus: row.http_status,
    error: row.error,
  };
}

function toEvent(row: EventRow): LaundryEvent {
  return {
    id: row.id,
    machineId: row.machine_id,
    appliance: row.appliance,
    sessionId: row.session_id,
    type: row.type,
    previousObservedAt: row.previous_observed_at,
    observedAt: row.observed_at,
    etaDeltaMinutes: row.eta_delta_minutes,
    previousState: row.previous_state,
    currentState: row.current_state,
    detail: JSON.parse(row.detail_json) as LaundryEvent["detail"],
  };
}

export class CloudflareStorage implements CollectorStorage {
  constructor(
    readonly db: D1Database,
    readonly bucket: R2Bucket,
  ) {}

  async readState(source: SourceName): Promise<SourceState | null> {
    const row = await this.db
      .prepare("SELECT * FROM source_state WHERE source = ?")
      .bind(source)
      .first<SourceStateRow>();
    return row ? toSourceState(row) : null;
  }

  async readAllStates(): Promise<SourceState[]> {
    const result = await this.db.prepare("SELECT * FROM source_state ORDER BY source").all<SourceStateRow>();
    return result.results.map(toSourceState);
  }

  async readObservation(source: SourceName, minute: number): Promise<MinuteObservation | null> {
    const row = await this.db
      .prepare("SELECT * FROM minute_observation WHERE source = ? AND minute_epoch = ?")
      .bind(source, minute)
      .first<ObservationRow>();
    return row ? toObservation(row) : null;
  }

  async listLaundryEvents(since: string | null, limit: number): Promise<LaundryEvent[]> {
    const statement = since
      ? this.db
          .prepare("SELECT * FROM laundry_event WHERE observed_at >= ? ORDER BY observed_at DESC LIMIT ?")
          .bind(since, limit)
      : this.db.prepare("SELECT * FROM laundry_event ORDER BY observed_at DESC LIMIT ?").bind(limit);
    const result = await statement.all<EventRow>();
    return result.results.map(toEvent);
  }

  async readJson<T>(key: string): Promise<T | null> {
    const object = await this.bucket.get(key);
    if (!object) return null;
    return JSON.parse(await object.text()) as T;
  }

  async readObject(key: string): Promise<R2ObjectBody | null> {
    return this.bucket.get(key);
  }

  async writeJson(key: string, value: unknown): Promise<void> {
    await this.bucket.put(key, JSON.stringify(value), {
      httpMetadata: { contentType: "application/json; charset=utf-8" },
    });
  }

  async writeRaw(key: string, raw: string): Promise<void> {
    await this.bucket.put(key, raw, {
      httpMetadata: { contentType: "application/json; charset=utf-8" },
    });
  }

  async objectExists(key: string): Promise<boolean> {
    return await this.bucket.head(key) !== null;
  }

  async writeBinary(key: string, object: BinaryObject): Promise<void> {
    await this.bucket.put(key, object.body, {
      httpMetadata: { contentType: object.contentType },
      ...(object.etag ? { customMetadata: { sha256: object.etag } } : {}),
    });
  }

  async commit(commit: CollectionCommit): Promise<void> {
    const { state, observation, version, laundryEvents = [] } = commit;
    const statements: D1PreparedStatement[] = [
      this.db
        .prepare(`
          INSERT INTO minute_observation (
            source, minute_epoch, scheduled_at, collected_at, status, version_sha,
            raw_key, normalized_key, version_first_seen_at, changed, duration_ms,
            http_status, error
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(source, minute_epoch) DO NOTHING
        `)
        .bind(
          observation.source,
          observation.minuteEpoch,
          observation.scheduledAt,
          observation.collectedAt,
          observation.status,
          observation.versionSha,
          observation.rawKey,
          observation.normalizedKey,
          observation.versionFirstSeenAt,
          observation.changed ? 1 : 0,
          observation.durationMs,
          observation.httpStatus,
          observation.error,
        ),
      this.db
        .prepare(`
          INSERT INTO source_state (
            source, last_attempt_at, last_success_at, last_response_sha, last_raw_key,
            last_normalized_key, version_first_seen_at, consecutive_failures, last_error
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(source) DO UPDATE SET
            last_attempt_at = excluded.last_attempt_at,
            last_success_at = excluded.last_success_at,
            last_response_sha = excluded.last_response_sha,
            last_raw_key = excluded.last_raw_key,
            last_normalized_key = excluded.last_normalized_key,
            version_first_seen_at = excluded.version_first_seen_at,
            consecutive_failures = excluded.consecutive_failures,
            last_error = excluded.last_error
          WHERE excluded.last_attempt_at >= source_state.last_attempt_at
        `)
        .bind(
          state.source,
          state.lastAttemptAt,
          state.lastSuccessAt,
          state.lastResponseSha,
          state.lastRawKey,
          state.lastNormalizedKey,
          state.versionFirstSeenAt,
          state.consecutiveFailures,
          state.lastError,
        ),
    ];

    if (version) {
      statements.push(this.db
        .prepare(`
          INSERT INTO source_version (source, sha, first_observed_at, raw_key, normalized_key)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(source, sha) DO NOTHING
        `)
        .bind(version.source, version.sha, version.firstObservedAt, version.rawKey, version.normalizedKey));
    }

    for (const event of laundryEvents) {
      statements.push(this.db
        .prepare(`
          INSERT INTO laundry_event (
            id, machine_id, appliance, session_id, type, previous_observed_at,
            observed_at, eta_delta_minutes, previous_state, current_state, detail_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO NOTHING
        `)
        .bind(
          event.id,
          event.machineId,
          event.appliance,
          event.sessionId,
          event.type,
          event.previousObservedAt,
          event.observedAt,
          event.etaDeltaMinutes,
          event.previousState,
          event.currentState,
          JSON.stringify(event.detail),
        ));
    }

    await this.db.batch(statements);
  }
}
