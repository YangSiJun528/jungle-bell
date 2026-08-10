export type SessionKind = "desktop" | "mobile";
export type LmsSessionState = "connected" | "login-required" | "unknown";

export interface AppSessionRecord {
  id: string;
  userId: string;
  installationId: string;
  kind: SessionKind;
  label: string | null;
  tokenSha256: string;
  createdAtEpochMs: number;
  expiresAtEpochMs: number;
  lastSeenAtEpochMs: number;
  revokedAtEpochMs: number | null;
  sourcePairingId: string | null;
}

export interface PairingRecord {
  id: string;
  userId: string;
  desktopInstallationId: string;
  pairingSecretSha256: string;
  manualCodeHash: string;
  claimReceiptSha256: string | null;
  status: "pending" | "claimed" | "approved" | "consumed";
  mobileInstallationId: string | null;
  mobileLabel: string | null;
  createdAtEpochMs: number;
  expiresAtEpochMs: number;
  approvedAtEpochMs: number | null;
}

export interface AttendanceSnapshotRecord {
  userId: string;
  sourceInstallationId: string;
  attendanceDate: string;
  cohortId: string | null;
  cohortStatus: "active" | "upcoming" | "ended" | "none" | "unknown";
  cohortStartDate: string | null;
  cohortEndDate: string | null;
  morningChecked: boolean;
  eveningChecked: boolean;
  collectedAtEpochMs: number;
  receivedAtEpochMs: number;
}

export interface AttendancePreferenceRecord {
  morning: boolean;
  evening: boolean;
  skipSunday: boolean;
  skipAttendanceDate: string | null;
}

export interface DesktopRecord {
  installationId: string;
  userId: string;
  lastSeenAtEpochMs: number | null;
  lmsSessionState: LmsSessionState;
  appVersion: string | null;
}

export interface NotificationRecord {
  id: string;
  userId: string;
  sourceEventId: string;
  kind: string;
  title: string;
  body: string;
  path: string;
  payloadJson: string;
  createdAtEpochMs: number;
  dueAtEpochMs: number;
  expiresAtEpochMs: number;
  desktopAttempt: number;
}

export interface PushSubscriptionRecord {
  id: string;
  userId: string;
  sessionId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  createdAtEpochMs: number;
  revokedAtEpochMs: number | null;
}

export interface PushDeliveryRecord {
  notificationId: string;
  subscription: PushSubscriptionRecord;
  payloadJson: string;
  expiresAtEpochMs: number;
  attempts: number;
}

export interface RenewalStore {
  issueVerifiedDesktopSession(input: {
    candidateUserId: string;
    subjectSha256: string;
    installationId: string;
    sessionId: string;
    tokenSha256: string;
    nowEpochMs: number;
    expiresAtEpochMs: number;
  }): Promise<void>;
  findSessionByTokenHash(tokenSha256: string): Promise<AppSessionRecord | null>;
  hasCurrentDesktopOwnership(input: {
    sessionId: string;
    userId: string;
    installationId: string;
  }): Promise<boolean>;
  touchSession(id: string, nowEpochMs: number): Promise<void>;
  recordDesktopHeartbeat(input: {
    userId: string;
    installationId: string;
    lmsSessionState: LmsSessionState;
    appVersion: string | null;
    nowEpochMs: number;
  }): Promise<boolean>;
  createPairing(pairing: PairingRecord): Promise<boolean>;
  getPairing(id: string): Promise<PairingRecord | null>;
  findPairingByProof(kind: "qr" | "manual", hash: string): Promise<PairingRecord | null>;
  claimPairing(input: {
    id: string;
    receiptSha256: string;
    mobileInstallationId: string;
    mobileLabel: string;
    nowEpochMs: number;
  }): Promise<boolean>;
  approvePairing(pairingId: string, desktopInstallationId: string, session: AppSessionRecord, nowEpochMs: number): Promise<boolean>;
  consumePairing(pairingId: string, receiptSha256: string, nowEpochMs: number): Promise<boolean>;
  listMobileSessions(userId: string): Promise<AppSessionRecord[]>;
  revokeMobileSession(userId: string, sessionId: string, nowEpochMs: number): Promise<boolean>;
  putNewestAttendanceSnapshot(snapshot: AttendanceSnapshotRecord): Promise<{ accepted: boolean; snapshot: AttendanceSnapshotRecord }>;
  getLatestAttendanceSnapshot(userId: string): Promise<AttendanceSnapshotRecord | null>;
  listAttendanceSubscriberUserIds(phase: "morning" | "evening"): Promise<string[]>;
  getAttendancePreference(userId: string): Promise<AttendancePreferenceRecord | null>;
  setAttendancePreference(userId: string, preference: AttendancePreferenceRecord, nowEpochMs: number): Promise<void>;
  listDesktopDevices(userId: string): Promise<DesktopRecord[]>;
  insertNotification(notification: NotificationRecord): Promise<boolean>;
  listDesktopInbox(userId: string, nowEpochMs: number, limit: number): Promise<NotificationRecord[]>;
  listNotificationHistory(userId: string, limit: number): Promise<NotificationRecord[]>;
  acknowledgeNotification(userId: string, notificationId: string, outcome: "displayed" | "failed", nowEpochMs: number): Promise<boolean>;
  upsertPushSubscription(subscription: PushSubscriptionRecord): Promise<void>;
  revokePushSubscription(userId: string, id: string, nowEpochMs: number): Promise<boolean>;
  listActivePushSubscriptions(userId: string, nowEpochMs: number): Promise<PushSubscriptionRecord[]>;
  queuePushDelivery(notificationId: string, subscriptionId: string, nowEpochMs: number): Promise<void>;
  listDuePushDeliveries(nowEpochMs: number, limit: number): Promise<PushDeliveryRecord[]>;
  recordPushDeliveryResult(input: {
    notificationId: string;
    subscriptionId: string;
    status: "delivered" | "retry" | "gone" | "failed";
    nowEpochMs: number;
    nextAttemptAtEpochMs: number | null;
    error: string | null;
  }): Promise<void>;
}

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

interface SnapshotRow {
  user_id: string; source_installation_id: string; attendance_date: string; cohort_id: string | null;
  cohort_status: AttendanceSnapshotRecord["cohortStatus"]; cohort_start_date: string | null; cohort_end_date: string | null;
  morning_checked: number; evening_checked: number; collected_at_epoch_ms: number; received_at_epoch_ms: number;
}

interface DesktopRow {
  installation_id: string; user_id: string; last_seen_at_epoch_ms: number | null;
  lms_session_state: LmsSessionState; app_version: string | null;
}

interface NotificationRow {
  id: string; user_id: string; source_event_id: string; kind: string; title: string; body: string; path: string;
  payload_json: string; created_at_epoch_ms: number; due_at_epoch_ms: number; expires_at_epoch_ms: number; desktop_attempt: number;
}

interface PushSubscriptionRow {
  id: string; user_id: string; session_id: string; endpoint: string; p256dh: string; auth: string;
  created_at_epoch_ms: number; revoked_at_epoch_ms: number | null;
}

interface PushDeliveryRow extends PushSubscriptionRow {
  notification_id: string; payload_json: string; expires_at_epoch_ms: number; attempts: number;
}

export class D1RenewalStore implements RenewalStore {
  constructor(private readonly db: D1Database) {}

  async issueVerifiedDesktopSession(input: {
    candidateUserId: string;
    subjectSha256: string;
    installationId: string;
    sessionId: string;
    tokenSha256: string;
    nowEpochMs: number;
    expiresAtEpochMs: number;
  }): Promise<void> {
    const results = await this.db.batch([
      this.db.prepare(`INSERT INTO app_user (id, lms_subject_sha256, created_at_epoch_ms, last_verified_at_epoch_ms)
        VALUES (?, ?, ?, ?) ON CONFLICT(lms_subject_sha256) DO UPDATE SET last_verified_at_epoch_ms = excluded.last_verified_at_epoch_ms`)
        .bind(input.candidateUserId, input.subjectSha256, input.nowEpochMs, input.nowEpochMs),
      this.db.prepare(`INSERT INTO desktop_device (installation_id, user_id, created_at_epoch_ms, last_verified_at_epoch_ms, last_seen_at_epoch_ms, lms_session_state, app_version)
        SELECT ?, id, ?, ?, ?, 'connected', NULL FROM app_user WHERE lms_subject_sha256 = ?
        ON CONFLICT(installation_id) DO UPDATE SET user_id = excluded.user_id,
        last_verified_at_epoch_ms = excluded.last_verified_at_epoch_ms, last_seen_at_epoch_ms = excluded.last_seen_at_epoch_ms, lms_session_state = 'connected'`)
        .bind(input.installationId, input.nowEpochMs, input.nowEpochMs, input.nowEpochMs, input.subjectSha256),
      this.db.prepare("UPDATE app_session SET revoked_at_epoch_ms = ? WHERE installation_id = ? AND kind = 'desktop' AND revoked_at_epoch_ms IS NULL")
        .bind(input.nowEpochMs, input.installationId),
      this.db.prepare(`INSERT INTO app_session (id, user_id, installation_id, kind, label, token_sha256, created_at_epoch_ms,
        expires_at_epoch_ms, last_seen_at_epoch_ms, revoked_at_epoch_ms, source_pairing_id)
        SELECT ?, user.id, ?, 'desktop', NULL, ?, ?, ?, ?, NULL, NULL FROM app_user user
        JOIN desktop_device desktop ON desktop.installation_id = ? AND desktop.user_id = user.id
        WHERE user.lms_subject_sha256 = ?`)
        .bind(input.sessionId, input.installationId, input.tokenSha256, input.nowEpochMs, input.expiresAtEpochMs,
          input.nowEpochMs, input.installationId, input.subjectSha256),
      this.db.prepare(`INSERT INTO attendance_preference
        (user_id, morning_enabled, evening_enabled, skip_sunday, skip_attendance_date, updated_at_epoch_ms)
        SELECT id, 1, 1, 0, NULL, ? FROM app_user WHERE lms_subject_sha256 = ?
        ON CONFLICT(user_id) DO NOTHING`).bind(input.nowEpochMs, input.subjectSha256),
    ]);
    if (results[1]?.meta.changes !== 1 || results[3]?.meta.changes !== 1) {
      throw new Error("IDENTITY_PERSISTENCE_FAILED");
    }
  }

  async findSessionByTokenHash(hash: string): Promise<AppSessionRecord | null> {
    const row = await this.db.prepare("SELECT * FROM app_session WHERE token_sha256 = ?").bind(hash).first<SessionRow>();
    return row ? session(row) : null;
  }

  async hasCurrentDesktopOwnership(input: { sessionId: string; userId: string; installationId: string }): Promise<boolean> {
    const row = await this.db.prepare(`SELECT 1 AS owned FROM app_session session
      JOIN desktop_device desktop ON desktop.installation_id = session.installation_id AND desktop.user_id = session.user_id
      WHERE session.id = ? AND session.user_id = ? AND session.installation_id = ? AND session.kind = 'desktop'
      AND session.revoked_at_epoch_ms IS NULL`).bind(input.sessionId, input.userId, input.installationId).first<{ owned: number }>();
    return row?.owned === 1;
  }

  async touchSession(id: string, now: number): Promise<void> {
    await this.db.prepare("UPDATE app_session SET last_seen_at_epoch_ms = ? WHERE id = ? AND last_seen_at_epoch_ms < ?")
      .bind(now, id, now - 6 * 60 * 60_000).run();
  }

  async recordDesktopHeartbeat(input: { userId: string; installationId: string; lmsSessionState: LmsSessionState; appVersion: string | null; nowEpochMs: number }): Promise<boolean> {
    const result = await this.db.prepare(`UPDATE desktop_device SET last_seen_at_epoch_ms = ?, lms_session_state = ?, app_version = COALESCE(?, app_version)
      WHERE installation_id = ? AND user_id = ?`).bind(input.nowEpochMs, input.lmsSessionState, input.appVersion, input.installationId, input.userId).run();
    return result.meta.changes === 1;
  }

  async createPairing(value: PairingRecord): Promise<boolean> {
    const result = await this.db.prepare(`INSERT OR IGNORE INTO pairing_challenge (id, user_id, desktop_installation_id,
      pairing_secret_sha256, manual_code_hash, claim_receipt_sha256, status, mobile_installation_id, mobile_label,
      created_at_epoch_ms, expires_at_epoch_ms, approved_at_epoch_ms) VALUES (?, ?, ?, ?, ?, NULL, 'pending', NULL, NULL, ?, ?, NULL)`)
      .bind(value.id, value.userId, value.desktopInstallationId, value.pairingSecretSha256, value.manualCodeHash,
        value.createdAtEpochMs, value.expiresAtEpochMs).run();
    return result.meta.changes === 1;
  }

  async getPairing(id: string): Promise<PairingRecord | null> {
    const row = await this.db.prepare("SELECT * FROM pairing_challenge WHERE id = ?").bind(id).first<PairingRow>();
    return row ? pairing(row) : null;
  }

  async findPairingByProof(kind: "qr" | "manual", hash: string): Promise<PairingRecord | null> {
    const column = kind === "qr" ? "pairing_secret_sha256" : "manual_code_hash";
    const row = await this.db.prepare(`SELECT * FROM pairing_challenge WHERE ${column} = ?`).bind(hash).first<PairingRow>();
    return row ? pairing(row) : null;
  }

  async claimPairing(input: { id: string; receiptSha256: string; mobileInstallationId: string; mobileLabel: string; nowEpochMs: number }): Promise<boolean> {
    const result = await this.db.prepare(`UPDATE pairing_challenge SET status = 'claimed', claim_receipt_sha256 = ?,
      mobile_installation_id = ?, mobile_label = ? WHERE id = ? AND status = 'pending' AND expires_at_epoch_ms > ?`)
      .bind(input.receiptSha256, input.mobileInstallationId, input.mobileLabel, input.id, input.nowEpochMs).run();
    return result.meta.changes === 1;
  }

  async approvePairing(pairingId: string, desktopId: string, value: AppSessionRecord, now: number): Promise<boolean> {
    const results = await this.db.batch([
      this.db.prepare(`INSERT INTO app_session (id, user_id, installation_id, kind, label, token_sha256, created_at_epoch_ms,
        expires_at_epoch_ms, last_seen_at_epoch_ms, revoked_at_epoch_ms, source_pairing_id)
        SELECT ?, user_id, mobile_installation_id, 'mobile', mobile_label, ?, ?, ?, ?, NULL, ? FROM pairing_challenge
        WHERE id = ? AND desktop_installation_id = ? AND status = 'claimed' AND expires_at_epoch_ms > ?`)
        .bind(value.id, value.tokenSha256, value.createdAtEpochMs, value.expiresAtEpochMs, value.lastSeenAtEpochMs,
          pairingId, pairingId, desktopId, now),
      this.db.prepare(`UPDATE pairing_challenge SET status = 'approved', approved_at_epoch_ms = ?
        WHERE id = ? AND desktop_installation_id = ? AND status = 'claimed' AND expires_at_epoch_ms > ?
        AND EXISTS (SELECT 1 FROM app_session WHERE id = ? AND source_pairing_id = ?)`)
        .bind(now, pairingId, desktopId, now, value.id, pairingId),
      this.db.prepare(`UPDATE push_subscription SET revoked_at_epoch_ms = ? WHERE revoked_at_epoch_ms IS NULL AND session_id IN
        (SELECT id FROM app_session WHERE kind = 'mobile' AND user_id = ? AND installation_id = ? AND id <> ?)
        AND EXISTS (SELECT 1 FROM pairing_challenge pairing JOIN app_session winner ON winner.source_pairing_id = pairing.id
          WHERE pairing.id = ? AND pairing.status = 'approved' AND winner.id = ? AND winner.revoked_at_epoch_ms IS NULL)`)
        .bind(now, value.userId, value.installationId, value.id, pairingId, value.id),
      this.db.prepare(`UPDATE app_session SET revoked_at_epoch_ms = ? WHERE kind = 'mobile' AND user_id = ?
        AND installation_id = ? AND id <> ? AND revoked_at_epoch_ms IS NULL
        AND EXISTS (SELECT 1 FROM pairing_challenge pairing JOIN app_session winner ON winner.source_pairing_id = pairing.id
          WHERE pairing.id = ? AND pairing.status = 'approved' AND winner.id = ? AND winner.revoked_at_epoch_ms IS NULL)`)
        .bind(now, value.userId, value.installationId, value.id, pairingId, value.id),
    ]);
    return results[0]?.meta.changes === 1 && results[1]?.meta.changes === 1;
  }

  async consumePairing(id: string, receiptHash: string, _now: number): Promise<boolean> {
    const result = await this.db.prepare(`UPDATE pairing_challenge SET status = 'consumed' WHERE id = ? AND status = 'approved'
      AND claim_receipt_sha256 = ?`).bind(id, receiptHash).run();
    return result.meta.changes === 1;
  }

  async listMobileSessions(userId: string): Promise<AppSessionRecord[]> {
    const result = await this.db.prepare("SELECT * FROM app_session WHERE user_id = ? AND kind = 'mobile' ORDER BY created_at_epoch_ms DESC")
      .bind(userId).all<SessionRow>();
    return result.results.map(session);
  }

  async revokeMobileSession(userId: string, id: string, now: number): Promise<boolean> {
    const result = await this.db.prepare(`UPDATE app_session SET revoked_at_epoch_ms = ? WHERE id = ? AND user_id = ?
      AND kind = 'mobile' AND revoked_at_epoch_ms IS NULL`).bind(now, id, userId).run();
    if (result.meta.changes === 1) {
      await this.db.prepare("UPDATE push_subscription SET revoked_at_epoch_ms = ? WHERE session_id = ? AND revoked_at_epoch_ms IS NULL")
        .bind(now, id).run();
    }
    return result.meta.changes === 1;
  }

  async putNewestAttendanceSnapshot(value: AttendanceSnapshotRecord): Promise<{ accepted: boolean; snapshot: AttendanceSnapshotRecord }> {
    const result = await this.db.prepare(`INSERT INTO attendance_snapshot (user_id, source_installation_id, attendance_date,
      cohort_id, cohort_status, cohort_start_date, cohort_end_date, morning_checked, evening_checked,
      collected_at_epoch_ms, received_at_epoch_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET source_installation_id = excluded.source_installation_id,
      attendance_date = excluded.attendance_date, cohort_id = excluded.cohort_id, cohort_status = excluded.cohort_status,
      cohort_start_date = excluded.cohort_start_date, cohort_end_date = excluded.cohort_end_date,
      morning_checked = excluded.morning_checked, evening_checked = excluded.evening_checked,
      collected_at_epoch_ms = excluded.collected_at_epoch_ms, received_at_epoch_ms = excluded.received_at_epoch_ms
      WHERE excluded.collected_at_epoch_ms > attendance_snapshot.collected_at_epoch_ms`)
      .bind(value.userId, value.sourceInstallationId, value.attendanceDate, value.cohortId, value.cohortStatus,
        value.cohortStartDate, value.cohortEndDate, value.morningChecked ? 1 : 0, value.eveningChecked ? 1 : 0,
        value.collectedAtEpochMs, value.receivedAtEpochMs).run();
    return { accepted: result.meta.changes === 1, snapshot: (await this.getLatestAttendanceSnapshot(value.userId))! };
  }

  async getLatestAttendanceSnapshot(userId: string): Promise<AttendanceSnapshotRecord | null> {
    const row = await this.db.prepare("SELECT * FROM attendance_snapshot WHERE user_id = ?").bind(userId).first<SnapshotRow>();
    return row ? snapshot(row) : null;
  }

  async listAttendanceSubscriberUserIds(phase: "morning" | "evening"): Promise<string[]> {
    const column = phase === "morning" ? "morning_enabled" : "evening_enabled";
    const result = await this.db.prepare(`SELECT user_id FROM attendance_preference WHERE ${column} = 1`).all<{ user_id: string }>();
    return result.results.map((row) => row.user_id);
  }

  async getAttendancePreference(userId: string): Promise<AttendancePreferenceRecord | null> {
    const row = await this.db.prepare(`SELECT morning_enabled, evening_enabled, skip_sunday, skip_attendance_date
      FROM attendance_preference WHERE user_id = ?`).bind(userId).first<{
        morning_enabled: number;
        evening_enabled: number;
        skip_sunday: number;
        skip_attendance_date: string | null;
      }>();
    return row ? {
      morning: row.morning_enabled === 1,
      evening: row.evening_enabled === 1,
      skipSunday: row.skip_sunday === 1,
      skipAttendanceDate: row.skip_attendance_date,
    } : null;
  }

  async setAttendancePreference(userId: string, preference: AttendancePreferenceRecord, now: number): Promise<void> {
    await this.db.prepare(`INSERT INTO attendance_preference
      (user_id, morning_enabled, evening_enabled, skip_sunday, skip_attendance_date, updated_at_epoch_ms)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET morning_enabled = excluded.morning_enabled,
      evening_enabled = excluded.evening_enabled, skip_sunday = excluded.skip_sunday,
      skip_attendance_date = excluded.skip_attendance_date, updated_at_epoch_ms = excluded.updated_at_epoch_ms`)
      .bind(userId, preference.morning ? 1 : 0, preference.evening ? 1 : 0,
        preference.skipSunday ? 1 : 0, preference.skipAttendanceDate, now).run();
  }

  async listDesktopDevices(userId: string): Promise<DesktopRecord[]> {
    const result = await this.db.prepare("SELECT installation_id, user_id, last_seen_at_epoch_ms, lms_session_state, app_version FROM desktop_device WHERE user_id = ?")
      .bind(userId).all<DesktopRow>();
    return result.results.map(desktop);
  }

  async insertNotification(value: NotificationRecord): Promise<boolean> {
    const result = await this.db.prepare(`INSERT OR IGNORE INTO notification (id, user_id, source_event_id, kind, title,
      body, path, payload_json, created_at_epoch_ms, due_at_epoch_ms, expires_at_epoch_ms, desktop_attempt, desktop_next_attempt_at_epoch_ms,
      desktop_displayed_at_epoch_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL)`)
      .bind(value.id, value.userId, value.sourceEventId, value.kind, value.title, value.body, value.path,
        value.payloadJson, value.createdAtEpochMs, value.dueAtEpochMs, value.expiresAtEpochMs, value.dueAtEpochMs).run();
    return result.meta.changes === 1;
  }

  async listDesktopInbox(userId: string, now: number, limit: number): Promise<NotificationRecord[]> {
    const result = await this.db.prepare(`SELECT * FROM notification WHERE user_id = ? AND desktop_displayed_at_epoch_ms IS NULL
      AND desktop_next_attempt_at_epoch_ms <= ? AND expires_at_epoch_ms > ? ORDER BY due_at_epoch_ms, id LIMIT ?`)
      .bind(userId, now, now, limit).all<NotificationRow>();
    if (result.results.length) {
      await this.db.batch(result.results.map((row) => this.db.prepare(`UPDATE notification SET desktop_attempt = desktop_attempt + 1,
        desktop_next_attempt_at_epoch_ms = ? WHERE id = ?`).bind(now + 2 * 60_000, row.id)));
    }
    return result.results.map((row) => ({ ...notification(row), desktopAttempt: row.desktop_attempt + 1 }));
  }

  async listNotificationHistory(userId: string, limit: number): Promise<NotificationRecord[]> {
    const result = await this.db.prepare("SELECT * FROM notification WHERE user_id = ? ORDER BY created_at_epoch_ms DESC LIMIT ?")
      .bind(userId, limit).all<NotificationRow>();
    return result.results.map((row) => ({ ...notification(row), desktopAttempt: Math.max(1, row.desktop_attempt) }));
  }

  async acknowledgeNotification(userId: string, id: string, outcome: "displayed" | "failed", now: number): Promise<boolean> {
    const result = outcome === "displayed"
      ? await this.db.prepare("UPDATE notification SET desktop_displayed_at_epoch_ms = ? WHERE id = ? AND user_id = ?")
          .bind(now, id, userId).run()
      : await this.db.prepare("UPDATE notification SET desktop_next_attempt_at_epoch_ms = ? WHERE id = ? AND user_id = ? AND desktop_displayed_at_epoch_ms IS NULL")
          .bind(now + 5_000, id, userId).run();
    return result.meta.changes === 1;
  }

  async upsertPushSubscription(value: PushSubscriptionRecord): Promise<void> {
    await this.db.batch([
      this.db.prepare(`UPDATE push_delivery SET status = 'failed', next_attempt_at_epoch_ms = NULL,
        last_error = 'PUSH_SUBSCRIPTION_REASSIGNED' WHERE subscription_id = ? AND status IN ('pending', 'retry')
        AND EXISTS (SELECT 1 FROM push_subscription WHERE id = ? AND (user_id <> ? OR session_id <> ?))`)
        .bind(value.id, value.id, value.userId, value.sessionId),
      this.db.prepare(`INSERT INTO push_subscription (id, user_id, session_id, endpoint, p256dh, auth, created_at_epoch_ms, revoked_at_epoch_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL) ON CONFLICT(id) DO UPDATE SET user_id = excluded.user_id, session_id = excluded.session_id,
        endpoint = excluded.endpoint, p256dh = excluded.p256dh, auth = excluded.auth,
        created_at_epoch_ms = excluded.created_at_epoch_ms, revoked_at_epoch_ms = NULL`)
        .bind(value.id, value.userId, value.sessionId, value.endpoint, value.p256dh, value.auth, value.createdAtEpochMs),
    ]);
  }

  async revokePushSubscription(userId: string, id: string, now: number): Promise<boolean> {
    const result = await this.db.prepare("UPDATE push_subscription SET revoked_at_epoch_ms = ? WHERE id = ? AND user_id = ? AND revoked_at_epoch_ms IS NULL")
      .bind(now, id, userId).run();
    return result.meta.changes === 1;
  }

  async listActivePushSubscriptions(userId: string, now: number): Promise<PushSubscriptionRecord[]> {
    const result = await this.db.prepare(`SELECT subscription.* FROM push_subscription subscription
      JOIN app_session session ON session.id = subscription.session_id
      WHERE subscription.user_id = ? AND subscription.revoked_at_epoch_ms IS NULL
      AND session.user_id = subscription.user_id AND session.kind = 'mobile'
      AND session.revoked_at_epoch_ms IS NULL AND session.expires_at_epoch_ms > ?`)
      .bind(userId, now).all<PushSubscriptionRow>();
    return result.results.map(pushSubscription);
  }

  async queuePushDelivery(notificationId: string, subscriptionId: string, now: number): Promise<void> {
    await this.db.prepare(`INSERT OR IGNORE INTO push_delivery (notification_id, subscription_id, status, attempts,
      next_attempt_at_epoch_ms, last_error, delivered_at_epoch_ms) VALUES (?, ?, 'pending', 0, ?, NULL, NULL)`)
      .bind(notificationId, subscriptionId, now).run();
  }

  async listDuePushDeliveries(now: number, limit: number): Promise<PushDeliveryRecord[]> {
    await this.db.prepare(`UPDATE push_delivery SET status = 'failed', last_error = 'NOTIFICATION_EXPIRED',
      next_attempt_at_epoch_ms = NULL WHERE status IN ('pending', 'retry') AND notification_id IN
      (SELECT id FROM notification WHERE expires_at_epoch_ms <= ?)`).bind(now).run();
    const result = await this.db.prepare(`SELECT d.notification_id, d.attempts, n.payload_json, n.expires_at_epoch_ms, s.* FROM push_delivery d
      JOIN notification n ON n.id = d.notification_id JOIN push_subscription s ON s.id = d.subscription_id
      JOIN app_session session ON session.id = s.session_id
      WHERE d.status IN ('pending', 'retry') AND d.next_attempt_at_epoch_ms <= ? AND s.revoked_at_epoch_ms IS NULL
      AND n.user_id = s.user_id AND session.kind = 'mobile' AND session.user_id = s.user_id AND session.revoked_at_epoch_ms IS NULL
      AND session.expires_at_epoch_ms > ? AND n.expires_at_epoch_ms > ?
      ORDER BY d.next_attempt_at_epoch_ms LIMIT ?`).bind(now, now, now, limit).all<PushDeliveryRow>();
    return result.results.map((row) => ({
      notificationId: row.notification_id,
      subscription: pushSubscription(row),
      payloadJson: row.payload_json,
      expiresAtEpochMs: row.expires_at_epoch_ms,
      attempts: row.attempts,
    }));
  }

  async recordPushDeliveryResult(input: { notificationId: string; subscriptionId: string; status: "delivered" | "retry" | "gone" | "failed"; nowEpochMs: number; nextAttemptAtEpochMs: number | null; error: string | null }): Promise<void> {
    await this.db.prepare(`UPDATE push_delivery SET status = ?, attempts = attempts + 1, next_attempt_at_epoch_ms = ?,
      last_error = ?, delivered_at_epoch_ms = CASE WHEN ? = 'delivered' THEN ? ELSE delivered_at_epoch_ms END
      WHERE notification_id = ? AND subscription_id = ?`).bind(input.status, input.nextAttemptAtEpochMs,
        input.error, input.status, input.nowEpochMs, input.notificationId, input.subscriptionId).run();
    if (input.status === "gone") {
      await this.db.prepare("UPDATE push_subscription SET revoked_at_epoch_ms = ? WHERE id = ?")
        .bind(input.nowEpochMs, input.subscriptionId).run();
    }
  }
}

function session(row: SessionRow): AppSessionRecord {
  return { id: row.id, userId: row.user_id, installationId: row.installation_id, kind: row.kind, label: row.label,
    tokenSha256: row.token_sha256, createdAtEpochMs: row.created_at_epoch_ms, expiresAtEpochMs: row.expires_at_epoch_ms,
    lastSeenAtEpochMs: row.last_seen_at_epoch_ms, revokedAtEpochMs: row.revoked_at_epoch_ms, sourcePairingId: row.source_pairing_id };
}
function pairing(row: PairingRow): PairingRecord {
  return { id: row.id, userId: row.user_id, desktopInstallationId: row.desktop_installation_id,
    pairingSecretSha256: row.pairing_secret_sha256, manualCodeHash: row.manual_code_hash,
    claimReceiptSha256: row.claim_receipt_sha256, status: row.status, mobileInstallationId: row.mobile_installation_id,
    mobileLabel: row.mobile_label, createdAtEpochMs: row.created_at_epoch_ms,
    expiresAtEpochMs: row.expires_at_epoch_ms, approvedAtEpochMs: row.approved_at_epoch_ms };
}
function snapshot(row: SnapshotRow): AttendanceSnapshotRecord {
  return { userId: row.user_id, sourceInstallationId: row.source_installation_id, attendanceDate: row.attendance_date,
    cohortId: row.cohort_id, cohortStatus: row.cohort_status, cohortStartDate: row.cohort_start_date,
    cohortEndDate: row.cohort_end_date, morningChecked: row.morning_checked === 1, eveningChecked: row.evening_checked === 1,
    collectedAtEpochMs: row.collected_at_epoch_ms, receivedAtEpochMs: row.received_at_epoch_ms };
}
function desktop(row: DesktopRow): DesktopRecord {
  return { installationId: row.installation_id, userId: row.user_id, lastSeenAtEpochMs: row.last_seen_at_epoch_ms,
    lmsSessionState: row.lms_session_state, appVersion: row.app_version };
}
function notification(row: NotificationRow): NotificationRecord {
  return { id: row.id, userId: row.user_id, sourceEventId: row.source_event_id, kind: row.kind, title: row.title,
    body: row.body, path: row.path, payloadJson: row.payload_json, createdAtEpochMs: row.created_at_epoch_ms,
    dueAtEpochMs: row.due_at_epoch_ms, expiresAtEpochMs: row.expires_at_epoch_ms, desktopAttempt: row.desktop_attempt };
}
function pushSubscription(row: PushSubscriptionRow): PushSubscriptionRecord {
  return { id: row.id, userId: row.user_id, sessionId: row.session_id, endpoint: row.endpoint, p256dh: row.p256dh,
    auth: row.auth, createdAtEpochMs: row.created_at_epoch_ms, revokedAtEpochMs: row.revoked_at_epoch_ms };
}
