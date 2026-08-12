import type { LaundryEvent } from "../collection/types";
import type { PlannedLaundryNotification } from "../domain/laundry-notifications";
import type {
  LaundryAppliance, LaundryAvailabilityTargetRecord, LaundryWatchRecord, LaundryWatchStatus,
  MealPeriod, MealPreferenceRecord, MealPublicationRecord,
} from "../ports/account-storage";
import type { SqlDatabase, SqlPreparedStatement } from "../ports/sql-database";

interface MealPreferenceRow { enabled: number; lunch: number; dinner: number; updated_at_epoch_ms: number }
interface MealPublicationRow {
  id: string; content_sha: string; title: string | null; text: string; published_at: string | null;
  updated_at: string | null; first_seen_at: string; has_prior_version: number;
}
interface LaundryWatchRow {
  id: string; user_id: string; machine_id: string; appliance: LaundryAppliance; session_id: string | null;
  notify_before_minutes: number; notify_when_available: number; status: LaundryWatchStatus;
  created_at_epoch_ms: number; updated_at_epoch_ms: number;
}
interface TargetLaundryWatchRow extends LaundryWatchRow { target_index: number }
interface LaundryEventRow {
  id: string; machine_id: string; appliance: LaundryAppliance; session_id: string | null;
  type: LaundryEvent["type"]; previous_observed_at: string | null; observed_at: string;
  eta_delta_minutes: number | null; previous_state: string | null; current_state: string; detail_json: string;
}

export class D1PersonalControlsRepository {
  constructor(private readonly db: SqlDatabase) {}

  async getMealPreference(userId: string): Promise<MealPreferenceRecord | null> {
    const row = await this.db.prepare(`SELECT enabled, lunch, dinner, updated_at_epoch_ms
      FROM meal_preference WHERE user_id = ?`).bind(userId).first<MealPreferenceRow>();
    return row ? {
      enabled: row.enabled === 1, lunch: row.lunch === 1,
      dinner: row.dinner === 1, updatedAtEpochMs: row.updated_at_epoch_ms,
    } : null;
  }

  async setMealPreference(userId: string, preference: MealPreferenceRecord): Promise<void> {
    await this.db.prepare(`INSERT INTO meal_preference
      (user_id, enabled, lunch, dinner, updated_at_epoch_ms) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET enabled = excluded.enabled,
      lunch = excluded.lunch, dinner = excluded.dinner, updated_at_epoch_ms = excluded.updated_at_epoch_ms
      WHERE excluded.updated_at_epoch_ms >= meal_preference.updated_at_epoch_ms`)
      .bind(userId, preference.enabled ? 1 : 0, preference.lunch ? 1 : 0,
        preference.dinner ? 1 : 0, preference.updatedAtEpochMs).run();
  }

  async listUnprocessedMealPosts(limit: number): Promise<MealPublicationRecord[]> {
    const result = await this.db.prepare(`SELECT post.id, post.content_sha, post.title, post.text,
      post.published_at, post.updated_at, post.first_seen_at,
      EXISTS (SELECT 1 FROM meal_post_processing prior WHERE prior.post_id = post.id) AS has_prior_version
      FROM meal_post post WHERE post.kind = 'DAILY_MENU'
      AND NOT EXISTS (SELECT 1 FROM meal_post_processing processed
        WHERE processed.post_id = post.id AND processed.content_sha = post.content_sha)
      ORDER BY post.first_seen_at, post.id LIMIT ?`).bind(limit).all<MealPublicationRow>();
    return result.results.map((row) => ({
      id: row.id, contentSha: row.content_sha, title: row.title, text: row.text,
      publishedAt: row.published_at, updatedAt: row.updated_at, firstSeenAt: row.first_seen_at,
      hasPriorVersion: row.has_prior_version === 1,
    }));
  }

  async listMealSubscriberUserIds(meal: MealPeriod, occurredAtEpochMs: number): Promise<string[]> {
    const column = meal === "lunch" ? "lunch" : "dinner";
    const result = await this.db.prepare(`SELECT user_id FROM meal_preference
      WHERE enabled = 1 AND ${column} = 1 AND updated_at_epoch_ms <= ? ORDER BY user_id`)
      .bind(occurredAtEpochMs).all<{ user_id: string }>();
    return result.results.map((row) => row.user_id);
  }

  async markMealPostProcessed(postId: string, contentSha: string, nowEpochMs: number): Promise<boolean> {
    const result = await this.db.prepare(`INSERT OR IGNORE INTO meal_post_processing
      (post_id, content_sha, processed_at_epoch_ms) VALUES (?, ?, ?)`)
      .bind(postId, contentSha, nowEpochMs).run();
    return result.meta.changes === 1;
  }

  async createWatch(value: LaundryWatchRecord, activeLimit: number): Promise<"created" | "duplicate" | "limit"> {
    const result = await this.db.prepare(`INSERT OR IGNORE INTO laundry_watch
      (id, user_id, machine_id, appliance, session_id, notify_before_minutes, notify_when_available,
        status, created_at_epoch_ms, updated_at_epoch_ms)
      SELECT ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?
      WHERE (SELECT count(*) FROM laundry_watch WHERE user_id = ? AND status = 'active') < ?`)
      .bind(value.id, value.userId, value.machineId, value.appliance, value.sessionId,
        value.notifyBeforeMinutes, value.notifyWhenAvailable ? 1 : 0, value.createdAtEpochMs,
        value.updatedAtEpochMs, value.userId, activeLimit).run();
    if (result.meta.changes === 1) return "created";
    const duplicate = await this.db.prepare(`SELECT 1 AS found FROM laundry_watch WHERE user_id = ?
      AND machine_id = ? AND appliance = ? AND session_id IS ? AND notify_when_available = ?
      AND status = 'active' LIMIT 1`).bind(value.userId, value.machineId, value.appliance, value.sessionId,
        value.notifyWhenAvailable ? 1 : 0).first<{ found: number }>();
    return duplicate?.found === 1 ? "duplicate" : "limit";
  }

  async listWatches(userId: string): Promise<LaundryWatchRecord[]> {
    const result = await this.db.prepare(`SELECT * FROM laundry_watch WHERE user_id = ?
      ORDER BY created_at_epoch_ms DESC, id LIMIT 128`).bind(userId).all<LaundryWatchRow>();
    return result.results.map(laundryWatch);
  }

  async cancelWatch(userId: string, id: string, now: number): Promise<boolean> {
    const result = await this.db.prepare(`UPDATE laundry_watch SET status = 'cancelled', updated_at_epoch_ms = ?
      WHERE id = ? AND user_id = ? AND status = 'active' AND created_at_epoch_ms <= ?`)
      .bind(now, id, userId, now).run();
    return result.meta.changes === 1;
  }

  async listPendingEvents(limit: number): Promise<LaundryEvent[]> {
    const result = await this.db.prepare(`SELECT event.* FROM laundry_event event
      LEFT JOIN laundry_lifecycle_processing processed ON processed.source_id = event.id
      WHERE processed.source_id IS NULL ORDER BY event.observed_at, event.id LIMIT ?`)
      .bind(limit).all<LaundryEventRow>();
    return result.results.map((row) => ({
      id: row.id, machineId: row.machine_id, appliance: row.appliance, sessionId: row.session_id,
      type: row.type, previousObservedAt: row.previous_observed_at, observedAt: row.observed_at,
      etaDeltaMinutes: row.eta_delta_minutes, previousState: row.previous_state, currentState: row.current_state,
      detail: JSON.parse(row.detail_json) as LaundryEvent["detail"],
    }));
  }

  async listActiveWatches(input: { machineId: string; appliance: LaundryAppliance; sessionId: string | null }): Promise<LaundryWatchRecord[]> {
    const result = await this.db.prepare(`SELECT * FROM laundry_watch WHERE status = 'active'
      AND machine_id = ? AND appliance = ? AND (session_id IS NULL OR session_id IS ?)
      ORDER BY user_id, id`).bind(input.machineId, input.appliance, input.sessionId).all<LaundryWatchRow>();
    return result.results.map(laundryWatch);
  }

  async listAvailabilityTargets(input: {
    appliances: ReadonlyArray<{ machineId: string; appliance: LaundryAppliance; sessionId: string | null }>;
  }): Promise<LaundryAvailabilityTargetRecord[]> {
    if (input.appliances.length === 0) return [];
    const encoded = JSON.stringify(input.appliances);
    const result = await this.db.prepare(`WITH target AS (
          SELECT CAST(key AS INTEGER) AS target_index,
            json_extract(value, '$.machineId') AS machine_id,
            json_extract(value, '$.appliance') AS appliance,
            json_extract(value, '$.sessionId') AS session_id
          FROM json_each(?)
        )
        SELECT target.target_index, watch.* FROM target JOIN laundry_watch watch
          ON watch.machine_id = target.machine_id AND watch.appliance = target.appliance
          AND (watch.session_id IS NULL OR watch.session_id IS target.session_id)
        WHERE watch.status = 'active' ORDER BY target.target_index, watch.user_id, watch.id`)
      .bind(encoded).all<TargetLaundryWatchRow>();
    const contexts = input.appliances.map((appliance) => ({
      ...appliance, watches: [] as LaundryWatchRecord[],
    }));
    for (const row of result.results) {
      contexts[row.target_index]?.watches.push(laundryWatch(row));
    }
    return contexts;
  }

  async applyLifecycleEvent(input: {
    eventId: string; processingToken: string; notifications: PlannedLaundryNotification[]; completedWatchIds: string[];
    nowEpochMs: number;
  }): Promise<boolean> {
    const statements: SqlPreparedStatement[] = [this.db.prepare(`INSERT OR IGNORE INTO laundry_lifecycle_processing
      (source_id, processing_token, processed_at_epoch_ms) VALUES (?, ?, ?)`)
      .bind(input.eventId, input.processingToken, input.nowEpochMs)];
    if (input.notifications.length) {
      const encoded = JSON.stringify(input.notifications.map((planned) => ({
        ...planned.notification,
        watchIds: planned.origins.map((origin) => origin.id),
      })));
      const statement = this.db.prepare(`WITH planned AS (
          SELECT value FROM json_each(?)
        )
        INSERT OR IGNORE INTO notification (id, user_id, source_event_id, kind, title,
          body, path, payload_json, created_at_epoch_ms, due_at_epoch_ms, expires_at_epoch_ms)
        SELECT json_extract(planned.value, '$.id'), json_extract(planned.value, '$.userId'),
          json_extract(planned.value, '$.sourceEventId'), json_extract(planned.value, '$.kind'),
          json_extract(planned.value, '$.title'), json_extract(planned.value, '$.body'),
          json_extract(planned.value, '$.path'), json_extract(planned.value, '$.payloadJson'),
          json_extract(planned.value, '$.createdAtEpochMs'), json_extract(planned.value, '$.dueAtEpochMs'),
          json_extract(planned.value, '$.expiresAtEpochMs')
        FROM planned WHERE EXISTS (SELECT 1 FROM laundry_lifecycle_processing
          WHERE source_id = ? AND processing_token = ?) AND EXISTS (
          SELECT 1 FROM json_each(planned.value, '$.watchIds') origin
            JOIN laundry_watch watch ON watch.id = origin.value
            WHERE watch.user_id = json_extract(planned.value, '$.userId') AND watch.status = 'active')`);
      statements.push(statement.bind(encoded, input.eventId, input.processingToken));
    }
    if (input.completedWatchIds.length) statements.push(this.db.prepare(`UPDATE laundry_watch
      SET status = 'completed', updated_at_epoch_ms = ? WHERE id IN (SELECT value FROM json_each(?))
      AND status = 'active' AND created_at_epoch_ms <= ? AND EXISTS
      (SELECT 1 FROM laundry_lifecycle_processing WHERE source_id = ? AND processing_token = ?)`)
      .bind(input.nowEpochMs, JSON.stringify(input.completedWatchIds), input.nowEpochMs,
        input.eventId, input.processingToken));
    const results = await this.db.batch(statements);
    return results[0]?.meta.changes === 1;
  }

}

function laundryWatch(row: LaundryWatchRow): LaundryWatchRecord {
  return {
    id: row.id, userId: row.user_id, machineId: row.machine_id, appliance: row.appliance,
    sessionId: row.session_id, notifyBeforeMinutes: row.notify_before_minutes,
    notifyWhenAvailable: row.notify_when_available === 1, status: row.status,
    createdAtEpochMs: row.created_at_epoch_ms, updatedAtEpochMs: row.updated_at_epoch_ms,
  };
}
