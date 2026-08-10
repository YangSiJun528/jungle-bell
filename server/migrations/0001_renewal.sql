-- Non-destructive 0.5.0 renewal schema for the existing Jungle Bell D1 database.
-- This migration only adds new tables and indexes. It must not include DROP statements.

CREATE TABLE IF NOT EXISTS app_user (
  id TEXT PRIMARY KEY,
  lms_subject_sha256 TEXT NOT NULL UNIQUE CHECK (length(lms_subject_sha256) = 64),
  created_at_epoch_ms INTEGER NOT NULL,
  last_verified_at_epoch_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS desktop_device (
  installation_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at_epoch_ms INTEGER NOT NULL,
  last_verified_at_epoch_ms INTEGER NOT NULL,
  last_seen_at_epoch_ms INTEGER,
  lms_session_state TEXT NOT NULL CHECK (lms_session_state IN ('connected', 'login-required', 'unknown')),
  app_version TEXT,
  FOREIGN KEY (user_id) REFERENCES app_user(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS desktop_device_user
  ON desktop_device (user_id);

CREATE TABLE IF NOT EXISTS app_session (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('desktop', 'mobile')),
  label TEXT,
  token_sha256 TEXT NOT NULL UNIQUE CHECK (length(token_sha256) = 64),
  created_at_epoch_ms INTEGER NOT NULL,
  expires_at_epoch_ms INTEGER NOT NULL,
  last_seen_at_epoch_ms INTEGER NOT NULL,
  revoked_at_epoch_ms INTEGER,
  source_pairing_id TEXT UNIQUE,
  FOREIGN KEY (user_id) REFERENCES app_user(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS app_session_user_kind
  ON app_session (user_id, kind, created_at_epoch_ms DESC);

CREATE UNIQUE INDEX IF NOT EXISTS app_session_active_desktop_installation
  ON app_session (installation_id)
  WHERE kind = 'desktop' AND revoked_at_epoch_ms IS NULL;

CREATE TABLE IF NOT EXISTS pairing_challenge (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  desktop_installation_id TEXT NOT NULL,
  pairing_secret_sha256 TEXT NOT NULL UNIQUE CHECK (length(pairing_secret_sha256) = 64),
  manual_code_hash TEXT NOT NULL UNIQUE CHECK (length(manual_code_hash) = 64),
  claim_receipt_sha256 TEXT UNIQUE CHECK (claim_receipt_sha256 IS NULL OR length(claim_receipt_sha256) = 64),
  status TEXT NOT NULL CHECK (status IN ('pending', 'claimed', 'approved', 'consumed')),
  mobile_installation_id TEXT,
  mobile_label TEXT,
  created_at_epoch_ms INTEGER NOT NULL,
  expires_at_epoch_ms INTEGER NOT NULL,
  approved_at_epoch_ms INTEGER,
  FOREIGN KEY (user_id) REFERENCES app_user(id) ON DELETE CASCADE,
  FOREIGN KEY (desktop_installation_id) REFERENCES desktop_device(installation_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS pairing_challenge_expiry
  ON pairing_challenge (expires_at_epoch_ms);

CREATE TABLE IF NOT EXISTS attendance_snapshot (
  user_id TEXT PRIMARY KEY,
  source_installation_id TEXT NOT NULL,
  attendance_date TEXT NOT NULL,
  cohort_id TEXT,
  cohort_status TEXT NOT NULL CHECK (cohort_status IN ('active', 'upcoming', 'ended', 'none', 'unknown')),
  cohort_start_date TEXT,
  cohort_end_date TEXT,
  morning_checked INTEGER NOT NULL CHECK (morning_checked IN (0, 1)),
  evening_checked INTEGER NOT NULL CHECK (evening_checked IN (0, 1)),
  collected_at_epoch_ms INTEGER NOT NULL,
  received_at_epoch_ms INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES app_user(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS attendance_preference (
  user_id TEXT PRIMARY KEY,
  morning_enabled INTEGER NOT NULL CHECK (morning_enabled IN (0, 1)),
  evening_enabled INTEGER NOT NULL CHECK (evening_enabled IN (0, 1)),
  skip_sunday INTEGER NOT NULL DEFAULT 0 CHECK (skip_sunday IN (0, 1)),
  skip_attendance_date TEXT CHECK (skip_attendance_date IS NULL OR skip_attendance_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  updated_at_epoch_ms INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES app_user(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS notification (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  path TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at_epoch_ms INTEGER NOT NULL,
  due_at_epoch_ms INTEGER NOT NULL,
  expires_at_epoch_ms INTEGER NOT NULL,
  desktop_attempt INTEGER NOT NULL DEFAULT 0,
  desktop_next_attempt_at_epoch_ms INTEGER NOT NULL,
  desktop_displayed_at_epoch_ms INTEGER,
  UNIQUE (user_id, source_event_id),
  FOREIGN KEY (user_id) REFERENCES app_user(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS notification_desktop_inbox
  ON notification (user_id, desktop_displayed_at_epoch_ms, desktop_next_attempt_at_epoch_ms, expires_at_epoch_ms);

CREATE TABLE IF NOT EXISTS push_subscription (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at_epoch_ms INTEGER NOT NULL,
  revoked_at_epoch_ms INTEGER,
  FOREIGN KEY (user_id) REFERENCES app_user(id) ON DELETE CASCADE,
  FOREIGN KEY (session_id) REFERENCES app_session(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS push_subscription_user
  ON push_subscription (user_id, revoked_at_epoch_ms);

CREATE TABLE IF NOT EXISTS push_delivery (
  notification_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'retry', 'delivered', 'gone', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at_epoch_ms INTEGER,
  last_error TEXT,
  delivered_at_epoch_ms INTEGER,
  PRIMARY KEY (notification_id, subscription_id),
  FOREIGN KEY (notification_id) REFERENCES notification(id) ON DELETE CASCADE,
  FOREIGN KEY (subscription_id) REFERENCES push_subscription(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS push_delivery_due
  ON push_delivery (status, next_attempt_at_epoch_ms);
