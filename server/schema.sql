-- This project supports only the current schema. Applying this file deletes all D1 data.
DROP TABLE IF EXISTS push_delivery;
DROP TABLE IF EXISTS push_subscription;
DROP TABLE IF EXISTS notification;
DROP TABLE IF EXISTS attendance_preference;
DROP TABLE IF EXISTS attendance_snapshot;
DROP TABLE IF EXISTS pairing_challenge;
DROP TABLE IF EXISTS app_session;
DROP TABLE IF EXISTS desktop_device;
DROP TABLE IF EXISTS app_user;
DROP TABLE IF EXISTS meal_image;
DROP TABLE IF EXISTS meal_weekly_menu;
DROP TABLE IF EXISTS meal_post;
DROP TABLE IF EXISTS laundry_event;
DROP TABLE IF EXISTS minute_observation;
DROP TABLE IF EXISTS source_version;
DROP TABLE IF EXISTS source_state;

CREATE TABLE source_state (
  source TEXT PRIMARY KEY CHECK (source IN ('laundry', 'meals-include-pinned', 'meals-default')),
  last_attempt_at TEXT NOT NULL,
  last_success_at TEXT,
  last_response_sha TEXT,
  last_raw_key TEXT,
  last_normalized_key TEXT,
  version_first_seen_at TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);

CREATE TABLE minute_observation (
  source TEXT NOT NULL,
  minute_epoch INTEGER NOT NULL,
  scheduled_at TEXT NOT NULL,
  collected_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('SUCCESS', 'FAILED', 'GAP')),
  version_sha TEXT,
  raw_key TEXT,
  normalized_key TEXT,
  version_first_seen_at TEXT,
  changed INTEGER NOT NULL CHECK (changed IN (0, 1)),
  duration_ms INTEGER NOT NULL,
  http_status INTEGER,
  error TEXT,
  PRIMARY KEY (source, minute_epoch)
);

CREATE INDEX minute_observation_collected_at
  ON minute_observation (collected_at);

CREATE TABLE laundry_event (
  id TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL,
  appliance TEXT NOT NULL CHECK (appliance IN ('washer', 'dryer')),
  session_id TEXT,
  type TEXT NOT NULL,
  previous_observed_at TEXT,
  observed_at TEXT NOT NULL,
  eta_delta_minutes REAL,
  previous_state TEXT,
  current_state TEXT NOT NULL,
  detail_json TEXT NOT NULL
);

CREATE INDEX laundry_event_observed_at
  ON laundry_event (observed_at DESC);

CREATE INDEX laundry_event_machine_session
  ON laundry_event (machine_id, appliance, session_id, observed_at);

CREATE TABLE meal_post (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('PINNED_MENU', 'DAILY_MENU', 'OTHER')),
  content_sha TEXT NOT NULL,
  title TEXT,
  text TEXT NOT NULL,
  pinned INTEGER NOT NULL CHECK (pinned IN (0, 1)),
  published_at TEXT,
  updated_at TEXT,
  permalink TEXT,
  status TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE INDEX meal_post_published_at
  ON meal_post (published_at DESC);

CREATE INDEX meal_post_kind_published_at
  ON meal_post (kind, published_at DESC);

CREATE TABLE meal_weekly_menu (
  week_key TEXT PRIMARY KEY,
  content_sha TEXT NOT NULL,
  post_json TEXT NOT NULL,
  updated_at TEXT,
  observed_at TEXT NOT NULL
);

CREATE INDEX meal_weekly_menu_updated_at
  ON meal_weekly_menu (updated_at DESC);

CREATE TABLE meal_image (
  post_id TEXT NOT NULL,
  media_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  source_url TEXT NOT NULL,
  declared_content_type TEXT,
  filename TEXT,
  width INTEGER,
  height INTEGER,
  sha TEXT NOT NULL,
  object_key TEXT NOT NULL,
  content_type TEXT NOT NULL,
  extension TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  PRIMARY KEY (post_id, media_id),
  FOREIGN KEY (post_id) REFERENCES meal_post(id) ON DELETE CASCADE
);

CREATE INDEX meal_image_post_position
  ON meal_image (post_id, position);

-- Renewal identity data. Raw LMS IDs and LMS credentials are intentionally absent.
CREATE TABLE app_user (
  id TEXT PRIMARY KEY,
  lms_subject_sha256 TEXT NOT NULL UNIQUE CHECK (length(lms_subject_sha256) = 64),
  created_at_epoch_ms INTEGER NOT NULL,
  last_verified_at_epoch_ms INTEGER NOT NULL
);

CREATE TABLE desktop_device (
  installation_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at_epoch_ms INTEGER NOT NULL,
  last_verified_at_epoch_ms INTEGER NOT NULL,
  last_seen_at_epoch_ms INTEGER,
  lms_session_state TEXT NOT NULL CHECK (lms_session_state IN ('connected', 'login-required', 'unknown')),
  app_version TEXT,
  FOREIGN KEY (user_id) REFERENCES app_user(id) ON DELETE CASCADE
);

CREATE INDEX desktop_device_user ON desktop_device (user_id);

-- Only SHA-256 token digests are durable. Session expiry is absolute, never sliding.
CREATE TABLE app_session (
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

CREATE INDEX app_session_user_kind ON app_session (user_id, kind, created_at_epoch_ms DESC);

CREATE UNIQUE INDEX app_session_active_desktop_installation
  ON app_session (installation_id)
  WHERE kind = 'desktop' AND revoked_at_epoch_ms IS NULL;

CREATE TABLE pairing_challenge (
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

CREATE INDEX pairing_challenge_expiry ON pairing_challenge (expires_at_epoch_ms);

-- One latest snapshot per user. Newer collected_at wins even if requests arrive out of order.
CREATE TABLE attendance_snapshot (
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

CREATE TABLE attendance_preference (
  user_id TEXT PRIMARY KEY,
  morning_enabled INTEGER NOT NULL CHECK (morning_enabled IN (0, 1)),
  evening_enabled INTEGER NOT NULL CHECK (evening_enabled IN (0, 1)),
  skip_sunday INTEGER NOT NULL DEFAULT 0 CHECK (skip_sunday IN (0, 1)),
  skip_attendance_date TEXT CHECK (skip_attendance_date IS NULL OR skip_attendance_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  updated_at_epoch_ms INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES app_user(id) ON DELETE CASCADE
);

CREATE TABLE notification (
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

CREATE INDEX notification_desktop_inbox ON notification (user_id, desktop_displayed_at_epoch_ms, desktop_next_attempt_at_epoch_ms, expires_at_epoch_ms);

CREATE TABLE push_subscription (
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

CREATE INDEX push_subscription_user ON push_subscription (user_id, revoked_at_epoch_ms);

CREATE TABLE push_delivery (
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

CREATE INDEX push_delivery_due ON push_delivery (status, next_attempt_at_epoch_ms);
