import { getLogger } from "@logtape/logtape";
import type { CollectionCommit, LaundryEvent } from "@jungle-bell/backend-common/collection/types";
import {
  weeklyMealMenu,
  withMealPostContentSha,
  type MealImageAsset,
  type MealPost,
} from "@jungle-bell/backend-common/collection/meals";

export type D1Parameter = string | number | null;

export interface D1Query {
  sql: string;
  params: D1Parameter[];
}

const logger = getLogger(["jungle-bell", "d1-commit"]);

function observationQuery(commit: CollectionCommit): D1Query {
  const { observation } = commit;
  return {
    sql: `
      INSERT INTO minute_observation (
        source, minute_epoch, scheduled_at, collected_at, status, version_sha,
        raw_key, normalized_key, version_first_seen_at, changed, duration_ms,
        http_status, error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source, minute_epoch) DO NOTHING
    `,
    params: [
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
    ],
  };
}

function stateQuery(commit: CollectionCommit): D1Query {
  const { state } = commit;
  return {
    sql: `
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
    `,
    params: [
      state.source,
      state.lastAttemptAt,
      state.lastSuccessAt,
      state.lastResponseSha,
      state.lastRawKey,
      state.lastNormalizedKey,
      state.versionFirstSeenAt,
      state.consecutiveFailures,
      state.lastError,
    ],
  };
}

function laundryEventsQuery(events: readonly LaundryEvent[]): D1Query {
  return {
    sql: `WITH input AS (SELECT value FROM json_each(?))
      INSERT INTO laundry_event (
        id, machine_id, appliance, session_id, type, previous_observed_at,
        observed_at, eta_delta_minutes, previous_state, current_state, detail_json
      ) SELECT json_extract(value, '$.id'), json_extract(value, '$.machineId'),
        json_extract(value, '$.appliance'), json_extract(value, '$.sessionId'),
        json_extract(value, '$.type'), json_extract(value, '$.previousObservedAt'),
        json_extract(value, '$.observedAt'), json_extract(value, '$.etaDeltaMinutes'),
        json_extract(value, '$.previousState'), json_extract(value, '$.currentState'),
        json_extract(value, '$.detailJson') FROM input WHERE 1
      ON CONFLICT(id) DO NOTHING
    `,
    params: [JSON.stringify(events.map((event) => ({ ...event, detailJson: JSON.stringify(event.detail) })))],
  };
}

interface EncodedWeeklyMenu {
  weekKey: string;
  contentSha: string;
  postJson: string;
  updatedAt: string | null;
  observedAt: string;
}

function weeklyMenusQuery(menus: readonly EncodedWeeklyMenu[]): D1Query {
  return {
    sql: `WITH input AS (SELECT value FROM json_each(?))
      INSERT INTO meal_weekly_menu (week_key, content_sha, post_json, updated_at, observed_at)
      SELECT json_extract(value, '$.weekKey'), json_extract(value, '$.contentSha'),
        json_extract(value, '$.postJson'), json_extract(value, '$.updatedAt'),
        json_extract(value, '$.observedAt') FROM input WHERE 1
      ON CONFLICT(week_key) DO UPDATE SET
        content_sha = excluded.content_sha,
        post_json = excluded.post_json,
        updated_at = excluded.updated_at,
        observed_at = excluded.observed_at
      WHERE excluded.content_sha <> meal_weekly_menu.content_sha
        AND excluded.observed_at >= meal_weekly_menu.observed_at
    `,
    params: [JSON.stringify(menus)],
  };
}

interface EncodedMealPost extends MealPost { observedAt: string }

function mealPostsQuery(posts: readonly EncodedMealPost[]): D1Query {
  return {
    sql: `WITH input AS (SELECT value FROM json_each(?))
      INSERT INTO meal_post (
        id, kind, content_sha, title, text, pinned, published_at, updated_at,
        permalink, status, first_seen_at, last_seen_at
      ) SELECT json_extract(value, '$.id'), json_extract(value, '$.kind'),
        json_extract(value, '$.contentSha'), json_extract(value, '$.title'),
        json_extract(value, '$.text'), json_extract(value, '$.pinned'),
        json_extract(value, '$.publishedAt'), json_extract(value, '$.updatedAt'),
        json_extract(value, '$.permalink'), json_extract(value, '$.status'),
        json_extract(value, '$.observedAt'), json_extract(value, '$.observedAt')
      FROM input WHERE 1
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
    `,
    params: [JSON.stringify(posts.map((post) => ({ ...post, pinned: post.pinned ? 1 : 0 })))],
  };
}

function deleteMealImagesQuery(postIds: readonly string[]): D1Query {
  return { sql: "DELETE FROM meal_image WHERE post_id IN (SELECT value FROM json_each(?))", params: [JSON.stringify(postIds)] };
}

interface EncodedMealImage extends MealImageAsset { position: number }

function mealImagesQuery(images: readonly EncodedMealImage[]): D1Query {
  return {
    sql: `WITH input AS (SELECT value FROM json_each(?))
      INSERT INTO meal_image (
        post_id, media_id, position, source_url, declared_content_type,
        filename, width, height, sha, object_key, content_type, extension,
        byte_length
      ) SELECT json_extract(value, '$.postId'), json_extract(value, '$.mediaId'),
        json_extract(value, '$.position'), json_extract(value, '$.sourceUrl'),
        json_extract(value, '$.declaredContentType'), json_extract(value, '$.filename'),
        json_extract(value, '$.width'), json_extract(value, '$.height'),
        json_extract(value, '$.sha'), json_extract(value, '$.objectKey'),
        json_extract(value, '$.contentType'), json_extract(value, '$.extension'),
        json_extract(value, '$.byteLength') FROM input
    `,
    params: [JSON.stringify(images)],
  };
}

/** Translates a normalized collector commit into an atomic D1 batch. */
export async function buildD1CommitQueries(commit: CollectionCommit): Promise<D1Query[]> {
  const queries = [observationQuery(commit), stateQuery(commit)];
  const laundryEvents = commit.laundryEvents ?? [];
  if (laundryEvents.length) queries.push(laundryEventsQuery(laundryEvents));

  const observedAt = commit.mealObservedAt ?? commit.observation.collectedAt;
  const posts: EncodedMealPost[] = [];
  const weeklyMenus: EncodedWeeklyMenu[] = [];
  const images: EncodedMealImage[] = [];
  for (const rawPost of commit.mealPosts ?? []) {
    const post = await withMealPostContentSha(rawPost);
    posts.push({ ...post, observedAt });
    images.push(...post.images.map((image, position) => ({ ...image, postId: post.id, position })));
    if (post.kind === "PINNED_MENU") {
      const weekly = await weeklyMealMenu(post, observedAt);
      if (weekly) {
        weeklyMenus.push({
          weekKey: weekly.weekKey, contentSha: weekly.contentSha, postJson: JSON.stringify(weekly.post),
          updatedAt: weekly.post.updatedAt, observedAt,
        });
      } else {
        logger.warn("Pinned meal title could not be assigned to a week", {
          postId: post.id,
          title: post.title,
          contentSha: post.contentSha,
          observedAt,
        });
      }
    }
  }
  if (weeklyMenus.length) queries.push(weeklyMenusQuery(weeklyMenus));
  if (posts.length) {
    queries.push(mealPostsQuery(posts), deleteMealImagesQuery(posts.map((post) => post.id)));
    if (images.length) queries.push(mealImagesQuery(images));
  }

  return queries;
}
