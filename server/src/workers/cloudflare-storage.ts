import { getLogger } from "@logtape/logtape";
import type {
  CollectionCommit,
  LaundryEvent,
  MinuteObservation,
  SourceName,
  SourceState,
} from "../collector/types";
import {
  weeklyMealMenu,
  withMealPostContentSha,
  type ArchivedMealPost,
  type MealImageAsset,
  type MealPost,
  type WeeklyMealMenu,
} from "../collector/meals";

const storageLogger = getLogger(["jungle-bell", "api-storage"]);

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

interface MealPostRow {
  id: string;
  kind: MealPost["kind"];
  content_sha: string;
  title: string | null;
  text: string;
  pinned: number;
  published_at: string | null;
  updated_at: string | null;
  permalink: string | null;
  status: string | null;
  first_seen_at: string;
  last_seen_at: string;
}

interface MealImageRow {
  post_id: string;
  media_id: string;
  position: number;
  source_url: string;
  declared_content_type: string | null;
  filename: string | null;
  width: number | null;
  height: number | null;
  sha: string;
  object_key: string;
  content_type: string;
  extension: string;
  byte_length: number;
}

interface WeeklyMealMenuRow {
  week_key: string;
  content_sha: string;
  post_json: string;
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

function toMealImage(row: MealImageRow): MealImageAsset {
  return {
    postId: row.post_id,
    mediaId: row.media_id,
    sourceUrl: row.source_url,
    declaredContentType: row.declared_content_type,
    filename: row.filename,
    width: row.width,
    height: row.height,
    sha: row.sha,
    objectKey: row.object_key,
    contentType: row.content_type,
    extension: row.extension,
    byteLength: row.byte_length,
  };
}

export class CloudflareApiStorage {
  constructor(
    readonly db: D1Database,
    readonly bucket: R2Bucket,
  ) {}

  async readJson<T>(key: string): Promise<T | null> {
    const object = await this.bucket.get(key);
    return object ? object.json<T>() : null;
  }

  async readObject(key: string): Promise<R2ObjectBody | null> {
    return this.bucket.get(key);
  }

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

  async listMealPosts(before: string | null, limit: number): Promise<ArchivedMealPost[]> {
    const statement = before
      ? this.db.prepare(`
          SELECT * FROM meal_post
          WHERE kind = 'DAILY_MENU' AND COALESCE(published_at, first_seen_at) < ?
          ORDER BY COALESCE(published_at, first_seen_at) DESC
          LIMIT ?
        `).bind(before, limit)
      : this.db.prepare(`
          SELECT * FROM meal_post
          WHERE kind = 'DAILY_MENU'
          ORDER BY COALESCE(published_at, first_seen_at) DESC
          LIMIT ?
        `).bind(limit);
    const posts = (await statement.all<MealPostRow>()).results;
    if (posts.length === 0) return [];

    const placeholders = posts.map(() => "?").join(", ");
    const imageResult = await this.db
      .prepare(`SELECT * FROM meal_image WHERE post_id IN (${placeholders}) ORDER BY post_id, position`)
      .bind(...posts.map((post) => post.id))
      .all<MealImageRow>();
    const imagesByPost = new Map<string, MealImageAsset[]>();
    for (const row of imageResult.results) {
      const images = imagesByPost.get(row.post_id) ?? [];
      images.push(toMealImage(row));
      imagesByPost.set(row.post_id, images);
    }

    return posts.map((post) => ({
      id: post.id,
      kind: post.kind,
      contentSha: post.content_sha,
      title: post.title,
      text: post.text,
      pinned: post.pinned === 1,
      publishedAt: post.published_at,
      updatedAt: post.updated_at,
      permalink: post.permalink,
      status: post.status,
      images: imagesByPost.get(post.id) ?? [],
      firstSeenAt: post.first_seen_at,
      lastSeenAt: post.last_seen_at,
    }));
  }

  async listWeeklyMealMenus(limit: number): Promise<WeeklyMealMenu[]> {
    const result = await this.db
      .prepare("SELECT week_key, content_sha, post_json FROM meal_weekly_menu ORDER BY week_key DESC LIMIT ?")
      .bind(limit)
      .all<WeeklyMealMenuRow>();
    return result.results.map((row) => ({
      weekKey: row.week_key,
      contentSha: row.content_sha,
      post: JSON.parse(row.post_json) as MealPost,
    }));
  }

  async applyCommit(commit: CollectionCommit): Promise<void> {
    const {
      state,
      observation,
      laundryEvents = [],
      mealPosts = [],
      mealObservedAt = observation.collectedAt,
    } = commit;
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

    for (const rawPost of mealPosts) {
      const post = await withMealPostContentSha(rawPost);
      if (post.kind === "PINNED_MENU") {
        const weekly = await weeklyMealMenu(post, mealObservedAt);
        if (weekly) {
          statements.push(this.db
            .prepare(`
              INSERT INTO meal_weekly_menu (week_key, content_sha, post_json, updated_at, observed_at)
              VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(week_key) DO UPDATE SET
                content_sha = excluded.content_sha,
                post_json = excluded.post_json,
                updated_at = excluded.updated_at,
                observed_at = excluded.observed_at
              WHERE excluded.content_sha <> meal_weekly_menu.content_sha
                AND excluded.observed_at >= meal_weekly_menu.observed_at
            `)
            .bind(
              weekly.weekKey,
              weekly.contentSha,
              JSON.stringify(weekly.post),
              post.updatedAt,
              mealObservedAt,
            ));
        } else {
          storageLogger.warn("Pinned meal title could not be assigned to a week", {
            postId: post.id,
            title: post.title,
            contentSha: post.contentSha,
            observedAt: mealObservedAt,
          });
        }
      }
      statements.push(this.db
        .prepare(`
          INSERT INTO meal_post (
            id, kind, content_sha, title, text, pinned, published_at, updated_at,
            permalink, status, first_seen_at, last_seen_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            kind = CASE
              WHEN meal_post.kind = 'PINNED_MENU' THEN meal_post.kind
              ELSE excluded.kind
            END,
            content_sha = excluded.content_sha,
            title = excluded.title,
            text = excluded.text,
            pinned = excluded.pinned,
            published_at = excluded.published_at,
            updated_at = excluded.updated_at,
            permalink = excluded.permalink,
            status = excluded.status,
            last_seen_at = excluded.last_seen_at
        `)
        .bind(
          post.id,
          post.kind,
          post.contentSha,
          post.title,
          post.text,
          post.pinned ? 1 : 0,
          post.publishedAt,
          post.updatedAt,
          post.permalink,
          post.status,
          mealObservedAt,
          mealObservedAt,
        ));
      statements.push(this.db.prepare("DELETE FROM meal_image WHERE post_id = ?").bind(post.id));
      for (const [position, image] of post.images.entries()) {
        statements.push(this.db
          .prepare(`
            INSERT INTO meal_image (
              post_id, media_id, position, source_url, declared_content_type,
              filename, width, height, sha, object_key, content_type, extension,
              byte_length
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `)
          .bind(
            post.id,
            image.mediaId,
            position,
            image.sourceUrl,
            image.declaredContentType,
            image.filename,
            image.width,
            image.height,
            image.sha,
            image.objectKey,
            image.contentType,
            image.extension,
            image.byteLength,
          ));
      }
    }

    await this.db.batch(statements);
  }
}
