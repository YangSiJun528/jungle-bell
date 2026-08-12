import { DESKTOP_ENROLLMENT_POLICY } from "../domain/enrollment-policy";
import type { SqlDatabase } from "../ports/sql-database";

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
const RUN_GUARD_SQL = `EXISTS (SELECT 1 FROM maintenance_state
  WHERE name = 'retention' AND run_token = ?)`;

export class D1HousekeepingRepository {
  constructor(private readonly db: SqlDatabase) {}

  async run(nowEpochMs: number): Promise<boolean> {
    const current = await this.db.prepare(`SELECT last_run_at_epoch_ms FROM maintenance_state
      WHERE name = 'retention'`).bind().first<{ last_run_at_epoch_ms: number }>();
    if (current && nowEpochMs - current.last_run_at_epoch_ms < HOUR_MS) return false;

    const cutoff30 = nowEpochMs - 30 * DAY_MS;
    const cutoff7 = nowEpochMs - 7 * DAY_MS;
    const abandonedEnrollmentCutoff = nowEpochMs - DESKTOP_ENROLLMENT_POLICY.abandonedRetentionMs;
    const cutoff30Iso = new Date(cutoff30).toISOString();
    const runToken = crypto.randomUUID();
    const results = await this.db.batch([
      this.db.prepare(`INSERT INTO maintenance_state (name, last_run_at_epoch_ms, run_token)
        VALUES ('retention', ?, ?) ON CONFLICT(name) DO UPDATE SET
          last_run_at_epoch_ms = excluded.last_run_at_epoch_ms, run_token = excluded.run_token
        WHERE excluded.last_run_at_epoch_ms - maintenance_state.last_run_at_epoch_ms >= ?`)
        .bind(nowEpochMs, runToken, HOUR_MS),
      this.db.prepare(`UPDATE notification_delivery SET status = 'failed', next_attempt_at_epoch_ms = NULL,
        last_error = 'MOBILE_SESSION_RETIRED', lease_token = NULL, lease_expires_at_epoch_ms = NULL
        WHERE target_kind = 'push' AND status IN ('pending', 'retry')
        AND target_id IN (SELECT subscription.id FROM push_subscription subscription
          JOIN app_session session ON session.id = subscription.session_id WHERE subscription.revoked_at_epoch_ms IS NOT NULL
          OR session.revoked_at_epoch_ms IS NOT NULL OR session.expires_at_epoch_ms <= ?)
        AND ${RUN_GUARD_SQL}`).bind(nowEpochMs, runToken),
      this.db.prepare(`UPDATE notification_delivery SET status = 'failed', next_attempt_at_epoch_ms = NULL,
        last_error = 'DESKTOP_SESSION_RETIRED' WHERE target_kind = 'desktop' AND status IN ('pending', 'retry')
        AND NOT EXISTS (SELECT 1 FROM app_session session WHERE session.kind = 'desktop'
          AND session.installation_id = notification_delivery.target_id
          AND session.revoked_at_epoch_ms IS NULL AND session.expires_at_epoch_ms > ?)
        AND ${RUN_GUARD_SQL}`).bind(nowEpochMs, runToken),
      this.db.prepare(`DELETE FROM notification_delivery WHERE target_kind = 'push' AND target_id IN
        (SELECT subscription.id FROM push_subscription subscription JOIN app_session session
          ON session.id = subscription.session_id WHERE
          (subscription.revoked_at_epoch_ms IS NOT NULL AND subscription.revoked_at_epoch_ms < ?)
          OR (session.revoked_at_epoch_ms IS NOT NULL AND session.revoked_at_epoch_ms < ?)
          OR session.expires_at_epoch_ms < ?) AND ${RUN_GUARD_SQL}`)
        .bind(cutoff30, cutoff30, cutoff30, runToken),
      this.db.prepare(`DELETE FROM push_subscription WHERE (
        (revoked_at_epoch_ms IS NOT NULL AND revoked_at_epoch_ms < ?) OR session_id IN
        (SELECT id FROM app_session WHERE kind = 'mobile' AND
          ((revoked_at_epoch_ms IS NOT NULL AND revoked_at_epoch_ms < ?) OR expires_at_epoch_ms < ?)))
        AND ${RUN_GUARD_SQL}`).bind(cutoff30, cutoff30, cutoff30, runToken),
      this.db.prepare(`DELETE FROM desktop_ui_session WHERE id IN (
        SELECT ui.id FROM desktop_ui_session ui WHERE ui.expires_at_epoch_ms <= ?
          OR NOT EXISTS (SELECT 1 FROM app_session parent WHERE parent.id = ui.parent_session_id
            AND parent.kind = 'desktop' AND parent.user_id = ui.user_id
            AND parent.installation_id = ui.installation_id
            AND parent.revoked_at_epoch_ms IS NULL AND parent.expires_at_epoch_ms > ?)
        ORDER BY ui.expires_at_epoch_ms LIMIT 500)
        AND ${RUN_GUARD_SQL}`).bind(nowEpochMs, nowEpochMs, runToken),
      this.db.prepare(`DELETE FROM app_session WHERE kind = 'mobile' AND
        ((revoked_at_epoch_ms IS NOT NULL AND revoked_at_epoch_ms < ?) OR expires_at_epoch_ms < ?)
        AND ${RUN_GUARD_SQL}`).bind(cutoff30, cutoff30, runToken),
      this.db.prepare(`DELETE FROM app_session WHERE kind = 'desktop' AND
        ((revoked_at_epoch_ms IS NOT NULL AND revoked_at_epoch_ms < ?) OR expires_at_epoch_ms < ?)
        AND ${RUN_GUARD_SQL}`).bind(cutoff30, cutoff30, runToken),
      this.db.prepare(`DELETE FROM app_user WHERE created_at_epoch_ms < ?
        AND NOT EXISTS (SELECT 1 FROM desktop_device desktop WHERE desktop.user_id = app_user.id
          AND desktop.activated_at_epoch_ms IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM app_session session WHERE session.user_id = app_user.id
          AND session.kind = 'mobile' AND session.revoked_at_epoch_ms IS NULL
          AND session.expires_at_epoch_ms > ?)
        AND ${RUN_GUARD_SQL}`).bind(abandonedEnrollmentCutoff, nowEpochMs, runToken),
      this.db.prepare(`DELETE FROM app_user WHERE NOT EXISTS
        (SELECT 1 FROM app_session session WHERE session.user_id = app_user.id)
        AND ${RUN_GUARD_SQL}`).bind(runToken),
      this.db.prepare(`DELETE FROM pairing_challenge WHERE (expires_at_epoch_ms < ?
        OR (status = 'consumed' AND approved_at_epoch_ms IS NOT NULL AND approved_at_epoch_ms < ?))
        AND ${RUN_GUARD_SQL}`).bind(cutoff7, cutoff7, runToken),
      this.db.prepare(`DELETE FROM pairing_claim_attempt WHERE window_started_at_epoch_ms < ?
        AND ${RUN_GUARD_SQL}`).bind(cutoff7, runToken),
      this.db.prepare(`DELETE FROM pairing_creation_attempt WHERE window_started_at_epoch_ms < ?
        AND ${RUN_GUARD_SQL}`).bind(cutoff7, runToken),
      this.db.prepare(`DELETE FROM desktop_enrollment_attempt WHERE window_started_at_epoch_ms < ?
        AND ${RUN_GUARD_SQL}`).bind(cutoff7, runToken),
      this.db.prepare(`DELETE FROM notification WHERE expires_at_epoch_ms < ? AND created_at_epoch_ms < ?
        AND ${RUN_GUARD_SQL}`).bind(nowEpochMs, cutoff30, runToken),
      this.db.prepare(`DELETE FROM meal_post_processing WHERE processed_at_epoch_ms < ?
        AND content_sha <> (SELECT post.content_sha FROM meal_post post
          WHERE post.id = meal_post_processing.post_id) AND ${RUN_GUARD_SQL}`).bind(cutoff30, runToken),
      this.db.prepare(`DELETE FROM laundry_watch WHERE status <> 'active' AND updated_at_epoch_ms < ?
        AND ${RUN_GUARD_SQL}`).bind(cutoff30, runToken),
      this.db.prepare(`DELETE FROM laundry_lifecycle_processing WHERE processed_at_epoch_ms < ? AND
        (source_id LIKE 'laundry-projection:%' OR source_id IN
          (SELECT id FROM laundry_event WHERE observed_at < ?)) AND ${RUN_GUARD_SQL}`)
        .bind(cutoff30, cutoff30Iso, runToken),
      this.db.prepare(`DELETE FROM laundry_event WHERE observed_at < ? AND ${RUN_GUARD_SQL}`)
        .bind(cutoff30Iso, runToken),
    ]);
    return results[0]?.meta.changes === 1;
  }
}
