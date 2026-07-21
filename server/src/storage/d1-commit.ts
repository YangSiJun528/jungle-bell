import { getLogger } from "@logtape/logtape";
import type { CollectionCommit, LaundryEvent } from "../collector/types";
import {
  weeklyMealMenu,
  withMealPostContentSha,
  type MealImageAsset,
  type MealPost,
} from "../collector/meals";

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

function laundryEventQuery(event: LaundryEvent): D1Query {
  return {
    sql: `
      INSERT INTO laundry_event (
        id, machine_id, appliance, session_id, type, previous_observed_at,
        observed_at, eta_delta_minutes, previous_state, current_state, detail_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `,
    params: [
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
    ],
  };
}

function weeklyMenuQuery(
  weekKey: string,
  contentSha: string,
  post: MealPost,
  observedAt: string,
): D1Query {
  return {
    sql: `
      INSERT INTO meal_weekly_menu (week_key, content_sha, post_json, updated_at, observed_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(week_key) DO UPDATE SET
        content_sha = excluded.content_sha,
        post_json = excluded.post_json,
        updated_at = excluded.updated_at,
        observed_at = excluded.observed_at
      WHERE excluded.content_sha <> meal_weekly_menu.content_sha
        AND excluded.observed_at >= meal_weekly_menu.observed_at
    `,
    params: [weekKey, contentSha, JSON.stringify(post), post.updatedAt, observedAt],
  };
}

function mealPostQuery(post: MealPost, observedAt: string): D1Query {
  return {
    sql: `
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
    `,
    params: [
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
      observedAt,
      observedAt,
    ],
  };
}

function deleteMealImagesQuery(postId: string): D1Query {
  return { sql: "DELETE FROM meal_image WHERE post_id = ?", params: [postId] };
}

function mealImageQuery(postId: string, position: number, image: MealImageAsset): D1Query {
  return {
    sql: `
      INSERT INTO meal_image (
        post_id, media_id, position, source_url, declared_content_type,
        filename, width, height, sha, object_key, content_type, extension,
        byte_length
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    params: [
      postId,
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
    ],
  };
}

export async function buildD1CommitQueries(commit: CollectionCommit): Promise<D1Query[]> {
  const queries = [observationQuery(commit), stateQuery(commit)];
  queries.push(...(commit.laundryEvents ?? []).map(laundryEventQuery));

  const observedAt = commit.mealObservedAt ?? commit.observation.collectedAt;
  for (const rawPost of commit.mealPosts ?? []) {
    const post = await withMealPostContentSha(rawPost);
    if (post.kind === "PINNED_MENU") {
      const weekly = await weeklyMealMenu(post, observedAt);
      if (weekly) {
        queries.push(weeklyMenuQuery(weekly.weekKey, weekly.contentSha, weekly.post, observedAt));
      } else {
        logger.warn("Pinned meal title could not be assigned to a week", {
          postId: post.id,
          title: post.title,
          contentSha: post.contentSha,
          observedAt,
        });
      }
    }

    queries.push(mealPostQuery(post, observedAt), deleteMealImagesQuery(post.id));
    for (const [position, image] of post.images.entries()) {
      queries.push(mealImageQuery(post.id, position, image));
    }
  }

  return queries;
}
