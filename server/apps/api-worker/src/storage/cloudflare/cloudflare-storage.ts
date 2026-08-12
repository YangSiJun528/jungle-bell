import type {
  LaundryEvent,
  MinuteObservation,
  SourceName,
  SourceState,
} from "@jungle-bell/backend-common/collection/types";
import {
  type ArchivedMealPost,
  type MealImageAsset,
  type MealPost,
  type WeeklyMealMenu,
} from "@jungle-bell/backend-common/collection/meals";
import type { MealHistoryCursor } from "@jungle-bell/backend-common/domain/meal-history";

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

  async listMealPosts(before: MealHistoryCursor | null, limit: number): Promise<ArchivedMealPost[]> {
    const statement = before
      ? this.db.prepare(`
          SELECT * FROM meal_post
          WHERE kind = 'DAILY_MENU' AND (
            COALESCE(published_at, first_seen_at) < ?
            OR (COALESCE(published_at, first_seen_at) = ? AND id < ?)
          )
          ORDER BY COALESCE(published_at, first_seen_at) DESC, id DESC
          LIMIT ?
        `).bind(before.timestamp, before.timestamp, before.postId, limit)
      : this.db.prepare(`
          SELECT * FROM meal_post
          WHERE kind = 'DAILY_MENU'
          ORDER BY COALESCE(published_at, first_seen_at) DESC, id DESC
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
}
