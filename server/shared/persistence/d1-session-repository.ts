import type { AppSessionRecord, LmsSessionState, PairingRecord, SessionKind } from "../ports/account-storage";
import type { SqlDatabase } from "../ports/sql-database";

interface SessionRow {
  id: string; user_id: string; installation_id: string; kind: SessionKind; label: string | null;
  token_sha256: string; created_at_epoch_ms: number; expires_at_epoch_ms: number;
  last_seen_at_epoch_ms: number; revoked_at_epoch_ms: number | null; source_pairing_id: string | null;
}
interface PairingRow {
  id: string; user_id: string; desktop_installation_id: string; pairing_secret_sha256: string;
  manual_code_hash: string; claim_receipt_sha256: string | null; status: PairingRecord["status"];
  mobile_installation_id: string | null; mobile_label: string | null; created_at_epoch_ms: number;
  expires_at_epoch_ms: number; approved_at_epoch_ms: number | null;
}

export class D1SessionRepository {
  constructor(private readonly db: SqlDatabase) {}

  async consumeDesktopEnrollmentAttempt(
    rateKey: string,
    now: number,
    windowMs: number,
    attemptLimit: number,
  ): Promise<boolean> {
    const result = await this.db.prepare(`INSERT INTO desktop_enrollment_attempt
      (rate_key, window_started_at_epoch_ms, attempt_count) VALUES (?, ?, 1)
      ON CONFLICT(rate_key) DO UPDATE SET
        window_started_at_epoch_ms = CASE WHEN excluded.window_started_at_epoch_ms
          - desktop_enrollment_attempt.window_started_at_epoch_ms >= ?
          THEN excluded.window_started_at_epoch_ms ELSE desktop_enrollment_attempt.window_started_at_epoch_ms END,
        attempt_count = CASE WHEN excluded.window_started_at_epoch_ms
          - desktop_enrollment_attempt.window_started_at_epoch_ms >= ?
          THEN 1 ELSE desktop_enrollment_attempt.attempt_count + 1 END
      WHERE excluded.window_started_at_epoch_ms - desktop_enrollment_attempt.window_started_at_epoch_ms >= ?
        OR desktop_enrollment_attempt.attempt_count < ?`)
      .bind(rateKey, now, windowMs, windowMs, windowMs, attemptLimit).run();
    return result.meta.changes === 1;
  }

  async enrollDesktop(input: {
    candidateUserId: string; installationId: string; sessionId: string; tokenSha256: string;
    nowEpochMs: number; expiresAtEpochMs: number;
  }): Promise<boolean> {
    const results = await this.db.batch([
      this.db.prepare(`INSERT INTO app_user (id, created_at_epoch_ms)
        SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM desktop_device WHERE installation_id = ?)`)
        .bind(input.candidateUserId, input.nowEpochMs, input.installationId),
      this.db.prepare(`INSERT INTO desktop_device (installation_id, user_id, created_at_epoch_ms,
        last_seen_at_epoch_ms, lms_session_state, app_version)
        SELECT ?, id, ?, ?, 'unknown', NULL FROM app_user WHERE id = ?`)
        .bind(input.installationId, input.nowEpochMs, input.nowEpochMs, input.candidateUserId),
      this.db.prepare(`INSERT INTO app_session (id, user_id, installation_id, kind, label, token_sha256,
        created_at_epoch_ms, expires_at_epoch_ms, last_seen_at_epoch_ms, revoked_at_epoch_ms, source_pairing_id)
        SELECT ?, user_id, ?, 'desktop', NULL, ?, ?, ?, ?, NULL, NULL FROM desktop_device
        WHERE installation_id = ? AND user_id = ?`)
        .bind(input.sessionId, input.installationId, input.tokenSha256, input.nowEpochMs,
          input.expiresAtEpochMs, input.nowEpochMs, input.installationId, input.candidateUserId),
      this.db.prepare(`INSERT INTO attendance_preference
        (user_id, morning_enabled, evening_enabled, skip_sunday, skip_attendance_date, updated_at_epoch_ms)
        SELECT id, 1, 1, 0, NULL, ? FROM app_user WHERE id = ?`)
        .bind(input.nowEpochMs, input.candidateUserId),
    ]);
    return results[0]?.meta.changes === 1 && results[1]?.meta.changes === 1 && results[2]?.meta.changes === 1;
  }

  async rotateDesktop(input: {
    currentSessionId: string; userId: string; installationId: string; newSessionId: string;
    tokenSha256: string; nowEpochMs: number; expiresAtEpochMs: number;
  }): Promise<boolean> {
    const results = await this.db.batch([
      this.db.prepare(`UPDATE app_session SET revoked_at_epoch_ms = ? WHERE id = ? AND user_id = ?
        AND installation_id = ? AND kind = 'desktop' AND revoked_at_epoch_ms IS NULL AND expires_at_epoch_ms > ?`)
        .bind(input.nowEpochMs, input.currentSessionId, input.userId, input.installationId, input.nowEpochMs),
      this.db.prepare(`INSERT INTO app_session (id, user_id, installation_id, kind, label, token_sha256,
        created_at_epoch_ms, expires_at_epoch_ms, last_seen_at_epoch_ms, revoked_at_epoch_ms, source_pairing_id)
        SELECT ?, user_id, installation_id, 'desktop', NULL, ?, ?, ?, ?, NULL, NULL FROM app_session
        WHERE id = ? AND user_id = ? AND installation_id = ? AND kind = 'desktop' AND revoked_at_epoch_ms = ?`)
        .bind(input.newSessionId, input.tokenSha256, input.nowEpochMs, input.expiresAtEpochMs,
          input.nowEpochMs, input.currentSessionId, input.userId, input.installationId, input.nowEpochMs),
      this.db.prepare(`UPDATE desktop_device SET activated_at_epoch_ms = COALESCE(activated_at_epoch_ms, ?)
        WHERE installation_id = ? AND user_id = ? AND EXISTS
          (SELECT 1 FROM app_session WHERE id = ? AND revoked_at_epoch_ms IS NULL)`)
        .bind(input.nowEpochMs, input.installationId, input.userId, input.newSessionId),
    ]);
    return results[0]?.meta.changes === 1 && results[1]?.meta.changes === 1;
  }

  async findByTokenHash(hash: string): Promise<AppSessionRecord | null> {
    const row = await this.db.prepare("SELECT * FROM app_session WHERE token_sha256 = ?").bind(hash).first<SessionRow>();
    return row ? session(row) : null;
  }

  async hasCurrentDesktopOwnership(input: { sessionId: string; userId: string; installationId: string }): Promise<boolean> {
    const row = await this.db.prepare(`SELECT 1 AS owned FROM app_session session
      JOIN desktop_device desktop ON desktop.installation_id = session.installation_id AND desktop.user_id = session.user_id
      WHERE session.id = ? AND session.user_id = ? AND session.installation_id = ? AND session.kind = 'desktop'
      AND session.revoked_at_epoch_ms IS NULL`).bind(input.sessionId, input.userId, input.installationId)
      .first<{ owned: number }>();
    return row?.owned === 1;
  }

  async touch(id: string, now: number): Promise<void> {
    await this.db.prepare("UPDATE app_session SET last_seen_at_epoch_ms = ? WHERE id = ? AND last_seen_at_epoch_ms < ?")
      .bind(now, id, now - 6 * 60 * 60_000).run();
  }

  async heartbeat(input: {
    userId: string; installationId: string; lmsSessionState: LmsSessionState;
    appVersion: string | null; nowEpochMs: number;
  }): Promise<boolean> {
    const result = await this.db.prepare(`UPDATE desktop_device SET last_seen_at_epoch_ms = ?,
      activated_at_epoch_ms = COALESCE(activated_at_epoch_ms, ?), lms_session_state = ?,
      app_version = COALESCE(?, app_version) WHERE installation_id = ? AND user_id = ?`)
      .bind(input.nowEpochMs, input.nowEpochMs, input.lmsSessionState, input.appVersion,
        input.installationId, input.userId).run();
    return result.meta.changes === 1;
  }

  async consumeManualPairingAttempt(
    rateKey: string,
    now: number,
    windowMs: number,
    attemptLimit: number,
  ): Promise<boolean> {
    const result = await this.db.prepare(`INSERT INTO pairing_claim_attempt
      (rate_key, window_started_at_epoch_ms, attempt_count) VALUES (?, ?, 1)
      ON CONFLICT(rate_key) DO UPDATE SET window_started_at_epoch_ms = CASE
        WHEN excluded.window_started_at_epoch_ms - pairing_claim_attempt.window_started_at_epoch_ms >= ?
        THEN excluded.window_started_at_epoch_ms ELSE pairing_claim_attempt.window_started_at_epoch_ms END,
        attempt_count = CASE WHEN excluded.window_started_at_epoch_ms
          - pairing_claim_attempt.window_started_at_epoch_ms >= ? THEN 1
          ELSE pairing_claim_attempt.attempt_count + 1 END
      WHERE excluded.window_started_at_epoch_ms - pairing_claim_attempt.window_started_at_epoch_ms >= ?
        OR pairing_claim_attempt.attempt_count < ?`)
      .bind(rateKey, now, windowMs, windowMs, windowMs, attemptLimit).run();
    return result.meta.changes === 1;
  }

  async consumePairingCreationAttempt(
    rateKey: string,
    now: number,
    windowMs: number,
    attemptLimit: number,
  ): Promise<boolean> {
    const result = await this.db.prepare(`INSERT INTO pairing_creation_attempt
      (rate_key, window_started_at_epoch_ms, attempt_count) VALUES (?, ?, 1)
      ON CONFLICT(rate_key) DO UPDATE SET window_started_at_epoch_ms = CASE
        WHEN excluded.window_started_at_epoch_ms - pairing_creation_attempt.window_started_at_epoch_ms >= ?
        THEN excluded.window_started_at_epoch_ms ELSE pairing_creation_attempt.window_started_at_epoch_ms END,
        attempt_count = CASE WHEN excluded.window_started_at_epoch_ms
          - pairing_creation_attempt.window_started_at_epoch_ms >= ? THEN 1
          ELSE pairing_creation_attempt.attempt_count + 1 END
      WHERE excluded.window_started_at_epoch_ms - pairing_creation_attempt.window_started_at_epoch_ms >= ?
        OR pairing_creation_attempt.attempt_count < ?`)
      .bind(rateKey, now, windowMs, windowMs, windowMs, attemptLimit).run();
    return result.meta.changes === 1;
  }

  async createPairing(value: PairingRecord): Promise<boolean> {
    const results = await this.db.batch([
      this.db.prepare(`INSERT OR IGNORE INTO pairing_challenge (id, user_id,
        desktop_installation_id, pairing_secret_sha256, manual_code_hash, claim_receipt_sha256, status,
        mobile_installation_id, mobile_label, created_at_epoch_ms, expires_at_epoch_ms, approved_at_epoch_ms)
        SELECT ?, ?, ?, ?, ?, NULL, 'pending', NULL, NULL, ?, ?, NULL
        WHERE NOT EXISTS (SELECT 1 FROM pairing_challenge
          WHERE desktop_installation_id = ? AND status IN ('pending', 'claimed')
          AND expires_at_epoch_ms > ?)`)
        .bind(value.id, value.userId, value.desktopInstallationId, value.pairingSecretSha256,
          value.manualCodeHash, value.createdAtEpochMs, value.expiresAtEpochMs,
          value.desktopInstallationId, value.createdAtEpochMs),
      this.db.prepare(`UPDATE desktop_device SET activated_at_epoch_ms = COALESCE(activated_at_epoch_ms, ?)
        WHERE installation_id = ? AND user_id = ? AND EXISTS
          (SELECT 1 FROM pairing_challenge WHERE id = ? AND user_id = ?)`)
        .bind(value.createdAtEpochMs, value.desktopInstallationId, value.userId, value.id, value.userId),
    ]);
    return results[0]?.meta.changes === 1;
  }

  async getPairing(id: string): Promise<PairingRecord | null> {
    const row = await this.db.prepare("SELECT * FROM pairing_challenge WHERE id = ?").bind(id).first<PairingRow>();
    return row ? pairing(row) : null;
  }

  async findPairingByProof(kind: "qr" | "manual", hash: string): Promise<PairingRecord | null> {
    const column = kind === "qr" ? "pairing_secret_sha256" : "manual_code_hash";
    const row = await this.db.prepare(`SELECT * FROM pairing_challenge WHERE ${column} = ?`)
      .bind(hash).first<PairingRow>();
    return row ? pairing(row) : null;
  }

  async claimPairing(input: {
    id: string; receiptSha256: string; mobileInstallationId: string; mobileLabel: string; nowEpochMs: number;
  }): Promise<boolean> {
    const result = await this.db.prepare(`UPDATE pairing_challenge SET status = 'claimed',
      claim_receipt_sha256 = ?, mobile_installation_id = ?, mobile_label = ?
      WHERE id = ? AND status = 'pending' AND expires_at_epoch_ms > ?`)
      .bind(input.receiptSha256, input.mobileInstallationId, input.mobileLabel, input.id, input.nowEpochMs).run();
    return result.meta.changes === 1;
  }

  async approvePairing(pairingId: string, desktopId: string, value: AppSessionRecord, now: number): Promise<boolean> {
    const results = await this.db.batch([
      this.db.prepare(`INSERT INTO app_session (id, user_id, installation_id, kind, label, token_sha256,
        created_at_epoch_ms, expires_at_epoch_ms, last_seen_at_epoch_ms, revoked_at_epoch_ms, source_pairing_id)
        SELECT ?, user_id, mobile_installation_id, 'mobile', mobile_label, ?, ?, ?, ?, NULL, ? FROM pairing_challenge
        WHERE id = ? AND desktop_installation_id = ? AND status = 'claimed' AND expires_at_epoch_ms > ?`)
        .bind(value.id, value.tokenSha256, value.createdAtEpochMs, value.expiresAtEpochMs,
          value.lastSeenAtEpochMs, pairingId, pairingId, desktopId, now),
      this.db.prepare(`UPDATE pairing_challenge SET status = 'approved', approved_at_epoch_ms = ?
        WHERE id = ? AND desktop_installation_id = ? AND status = 'claimed' AND expires_at_epoch_ms > ?
        AND EXISTS (SELECT 1 FROM app_session WHERE id = ? AND source_pairing_id = ?)`)
        .bind(now, pairingId, desktopId, now, value.id, pairingId),
      this.db.prepare(`UPDATE notification_delivery SET status = 'failed', next_attempt_at_epoch_ms = NULL,
        last_error = 'MOBILE_SESSION_REPLACED', lease_token = NULL, lease_expires_at_epoch_ms = NULL
        WHERE target_kind = 'push' AND status IN ('pending', 'retry')
        AND target_id IN (SELECT subscription.id FROM push_subscription subscription JOIN app_session old
          ON old.id = subscription.session_id WHERE old.kind = 'mobile' AND old.user_id = ?
          AND old.installation_id = ? AND old.id <> ?)
        AND EXISTS (SELECT 1 FROM pairing_challenge pairing JOIN app_session winner
          ON winner.source_pairing_id = pairing.id WHERE pairing.id = ? AND pairing.status = 'approved'
          AND winner.id = ? AND winner.revoked_at_epoch_ms IS NULL)`)
        .bind(value.userId, value.installationId, value.id, pairingId, value.id),
      this.db.prepare(`UPDATE push_subscription SET revoked_at_epoch_ms = ? WHERE revoked_at_epoch_ms IS NULL
        AND session_id IN (SELECT id FROM app_session WHERE kind = 'mobile' AND user_id = ?
          AND installation_id = ? AND id <> ?) AND EXISTS (SELECT 1 FROM pairing_challenge pairing
          JOIN app_session winner ON winner.source_pairing_id = pairing.id WHERE pairing.id = ?
          AND pairing.status = 'approved' AND winner.id = ? AND winner.revoked_at_epoch_ms IS NULL)`)
        .bind(now, value.userId, value.installationId, value.id, pairingId, value.id),
      this.db.prepare(`UPDATE app_session SET revoked_at_epoch_ms = ? WHERE kind = 'mobile' AND user_id = ?
        AND installation_id = ? AND id <> ? AND revoked_at_epoch_ms IS NULL
        AND EXISTS (SELECT 1 FROM pairing_challenge pairing JOIN app_session winner
          ON winner.source_pairing_id = pairing.id WHERE pairing.id = ? AND pairing.status = 'approved'
          AND winner.id = ? AND winner.revoked_at_epoch_ms IS NULL)`)
        .bind(now, value.userId, value.installationId, value.id, pairingId, value.id),
    ]);
    return results[0]?.meta.changes === 1 && results[1]?.meta.changes === 1;
  }

  async consumePairing(id: string, receiptHash: string): Promise<boolean> {
    const result = await this.db.prepare(`UPDATE pairing_challenge SET status = 'consumed'
      WHERE id = ? AND status = 'approved' AND claim_receipt_sha256 = ?`).bind(id, receiptHash).run();
    return result.meta.changes === 1;
  }

  async listMobileSessions(userId: string): Promise<AppSessionRecord[]> {
    const result = await this.db.prepare(`SELECT * FROM app_session WHERE user_id = ? AND kind = 'mobile'
      ORDER BY created_at_epoch_ms DESC`).bind(userId).all<SessionRow>();
    return result.results.map(session);
  }

  async revokeMobileSession(userId: string, id: string, now: number): Promise<boolean> {
    const results = await this.db.batch([
      this.db.prepare(`UPDATE app_session SET revoked_at_epoch_ms = ? WHERE id = ?
        AND user_id = ? AND kind = 'mobile' AND revoked_at_epoch_ms IS NULL`).bind(now, id, userId),
      this.db.prepare(`UPDATE notification_delivery SET status = 'failed', next_attempt_at_epoch_ms = NULL,
        last_error = 'MOBILE_SESSION_REVOKED', lease_token = NULL, lease_expires_at_epoch_ms = NULL
        WHERE target_kind = 'push' AND status IN ('pending', 'retry')
        AND target_id IN (SELECT subscription.id FROM push_subscription subscription JOIN app_session session
          ON session.id = subscription.session_id WHERE subscription.session_id = ?
          AND session.user_id = ? AND session.kind = 'mobile' AND session.revoked_at_epoch_ms = ?)`)
        .bind(id, userId, now),
      this.db.prepare(`UPDATE push_subscription SET revoked_at_epoch_ms = ?
        WHERE session_id = ? AND revoked_at_epoch_ms IS NULL AND EXISTS
          (SELECT 1 FROM app_session session WHERE session.id = push_subscription.session_id
            AND session.user_id = ? AND session.kind = 'mobile' AND session.revoked_at_epoch_ms = ?)`)
        .bind(now, id, userId, now),
    ]);
    return results[0]?.meta.changes === 1;
  }
}

function session(row: SessionRow): AppSessionRecord {
  return {
    id: row.id, userId: row.user_id, installationId: row.installation_id, kind: row.kind, label: row.label,
    tokenSha256: row.token_sha256, createdAtEpochMs: row.created_at_epoch_ms,
    expiresAtEpochMs: row.expires_at_epoch_ms, lastSeenAtEpochMs: row.last_seen_at_epoch_ms,
    revokedAtEpochMs: row.revoked_at_epoch_ms, sourcePairingId: row.source_pairing_id,
  };
}
function pairing(row: PairingRow): PairingRecord {
  return {
    id: row.id, userId: row.user_id, desktopInstallationId: row.desktop_installation_id,
    pairingSecretSha256: row.pairing_secret_sha256, manualCodeHash: row.manual_code_hash,
    claimReceiptSha256: row.claim_receipt_sha256, status: row.status,
    mobileInstallationId: row.mobile_installation_id, mobileLabel: row.mobile_label,
    createdAtEpochMs: row.created_at_epoch_ms, expiresAtEpochMs: row.expires_at_epoch_ms,
    approvedAtEpochMs: row.approved_at_epoch_ms,
  };
}
