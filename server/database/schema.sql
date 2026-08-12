-- This project supports only the current schema. Applying this file deletes all D1 data.
DROP TABLE IF EXISTS notification_delivery;
DROP TABLE IF EXISTS push_subscription;
DROP TABLE IF EXISTS notification;
DROP TABLE IF EXISTS laundry_queue_claim;
DROP TABLE IF EXISTS laundry_queue_entry;
DROP TABLE IF EXISTS laundry_watch;
DROP TABLE IF EXISTS meal_preference;
DROP TABLE IF EXISTS attendance_preference;
DROP TABLE IF EXISTS attendance_snapshot;
DROP TABLE IF EXISTS pairing_challenge;
DROP TABLE IF EXISTS pairing_creation_attempt;
DROP TABLE IF EXISTS pairing_claim_attempt;
DROP TABLE IF EXISTS app_session;
DROP TABLE IF EXISTS desktop_device;
DROP TABLE IF EXISTS desktop_enrollment_attempt;
DROP TABLE IF EXISTS app_user;
DROP TABLE IF EXISTS meal_image;
DROP TABLE IF EXISTS meal_weekly_menu;
DROP TABLE IF EXISTS meal_post_processing;
DROP TABLE IF EXISTS meal_post;
DROP TABLE IF EXISTS laundry_lifecycle_processing;
DROP TABLE IF EXISTS laundry_event;
DROP TABLE IF EXISTS minute_observation;
DROP TABLE IF EXISTS source_state;
DROP TABLE IF EXISTS maintenance_state;

CREATE TABLE maintenance_state (
  name TEXT PRIMARY KEY,
  last_run_at_epoch_ms INTEGER NOT NULL,
  run_token TEXT NOT NULL
);

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

CREATE TABLE laundry_lifecycle_processing (
  source_id TEXT PRIMARY KEY,
  processing_token TEXT NOT NULL UNIQUE,
  processed_at_epoch_ms INTEGER NOT NULL
);

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

CREATE TABLE meal_post_processing (
  post_id TEXT NOT NULL,
  content_sha TEXT NOT NULL,
  processed_at_epoch_ms INTEGER NOT NULL,
  PRIMARY KEY (post_id, content_sha),
  FOREIGN KEY (post_id) REFERENCES meal_post(id) ON DELETE CASCADE
);

CREATE INDEX meal_post_processing_time
  ON meal_post_processing (processed_at_epoch_ms);

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

-- App identity is installation-scoped. LMS IDs, cookies and tokens never reach this server.
CREATE TABLE app_user (
  id TEXT PRIMARY KEY,
  created_at_epoch_ms INTEGER NOT NULL
);

CREATE TABLE desktop_enrollment_attempt (
  rate_key TEXT PRIMARY KEY,
  window_started_at_epoch_ms INTEGER NOT NULL,
  attempt_count INTEGER NOT NULL CHECK (attempt_count > 0)
);

CREATE TABLE desktop_device (
  installation_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at_epoch_ms INTEGER NOT NULL,
  activated_at_epoch_ms INTEGER CHECK (activated_at_epoch_ms IS NULL OR activated_at_epoch_ms >= created_at_epoch_ms),
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

CREATE TABLE pairing_claim_attempt (
  rate_key TEXT PRIMARY KEY,
  window_started_at_epoch_ms INTEGER NOT NULL,
  attempt_count INTEGER NOT NULL CHECK (attempt_count > 0)
);

CREATE TABLE pairing_creation_attempt (
  rate_key TEXT PRIMARY KEY,
  window_started_at_epoch_ms INTEGER NOT NULL,
  attempt_count INTEGER NOT NULL CHECK (attempt_count > 0)
);

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
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  morning_enabled INTEGER NOT NULL CHECK (morning_enabled IN (0, 1)),
  evening_enabled INTEGER NOT NULL CHECK (evening_enabled IN (0, 1)),
  morning_start_hour INTEGER NOT NULL DEFAULT 9 CHECK (morning_start_hour BETWEEN 4 AND 9),
  evening_end_hour INTEGER NOT NULL DEFAULT 4 CHECK (evening_end_hour BETWEEN 0 AND 4),
  morning_interval_minutes INTEGER NOT NULL DEFAULT 15 CHECK (morning_interval_minutes IN (1, 3, 5, 10, 15, 30)),
  evening_interval_minutes INTEGER NOT NULL DEFAULT 15 CHECK (evening_interval_minutes IN (1, 3, 5, 10, 15, 30)),
  skip_sunday INTEGER NOT NULL DEFAULT 0 CHECK (skip_sunday IN (0, 1)),
  skip_attendance_date TEXT CHECK (skip_attendance_date IS NULL OR skip_attendance_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  updated_at_epoch_ms INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES app_user(id) ON DELETE CASCADE
);

CREATE INDEX attendance_preference_morning_subscriber
  ON attendance_preference(enabled, morning_enabled, user_id);
CREATE INDEX attendance_preference_evening_subscriber
  ON attendance_preference(enabled, evening_enabled, user_id);

CREATE TABLE meal_preference (
  user_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  breakfast INTEGER NOT NULL CHECK (breakfast IN (0, 1)),
  lunch INTEGER NOT NULL CHECK (lunch IN (0, 1)),
  dinner INTEGER NOT NULL CHECK (dinner IN (0, 1)),
  updated_at_epoch_ms INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES app_user(id) ON DELETE CASCADE
);

CREATE TABLE laundry_watch (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  machine_id TEXT NOT NULL CHECK (length(machine_id) BETWEEN 1 AND 128),
  appliance TEXT NOT NULL CHECK (appliance IN ('washer', 'dryer')),
  session_id TEXT CHECK (session_id IS NULL OR length(session_id) BETWEEN 1 AND 256),
  notify_before_minutes INTEGER NOT NULL CHECK (notify_before_minutes BETWEEN 0 AND 180),
  notify_when_available INTEGER NOT NULL CHECK (notify_when_available IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'cancelled')),
  created_at_epoch_ms INTEGER NOT NULL,
  updated_at_epoch_ms INTEGER NOT NULL CHECK (updated_at_epoch_ms >= created_at_epoch_ms),
  FOREIGN KEY (user_id) REFERENCES app_user(id) ON DELETE CASCADE
);

CREATE INDEX laundry_watch_user_history ON laundry_watch (user_id, created_at_epoch_ms DESC, id);
CREATE INDEX laundry_watch_active_target ON laundry_watch (machine_id, appliance, session_id, user_id)
  WHERE status = 'active';
CREATE UNIQUE INDEX laundry_watch_active_dedupe ON laundry_watch
  (user_id, machine_id, appliance, ifnull(session_id, ''), notify_when_available)
  WHERE status = 'active';

CREATE TABLE laundry_queue_entry (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  machine_id TEXT CHECK (machine_id IS NULL OR length(machine_id) BETWEEN 1 AND 128),
  appliance TEXT NOT NULL CHECK (appliance IN ('washer', 'dryer')),
  status TEXT NOT NULL CHECK (status IN ('waiting', 'claimed', 'cancelled', 'expired')),
  joined_at_epoch_ms INTEGER NOT NULL,
  left_at_epoch_ms INTEGER,
  CHECK ((status = 'waiting' AND left_at_epoch_ms IS NULL) OR (status <> 'waiting' AND left_at_epoch_ms IS NOT NULL)),
  FOREIGN KEY (user_id) REFERENCES app_user(id) ON DELETE CASCADE
);

CREATE INDEX laundry_queue_order ON laundry_queue_entry
  (appliance, machine_id, status, joined_at_epoch_ms, id);
CREATE UNIQUE INDEX laundry_queue_one_waiting_per_user ON laundry_queue_entry
  (user_id, appliance, ifnull(machine_id, '')) WHERE status = 'waiting';

CREATE TABLE laundry_queue_claim (
  queue_entry_id TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL CHECK (length(machine_id) BETWEEN 1 AND 128),
  appliance TEXT NOT NULL CHECK (appliance IN ('washer', 'dryer')),
  claim_token TEXT NOT NULL UNIQUE,
  claimed_at_epoch_ms INTEGER NOT NULL,
  expires_at_epoch_ms INTEGER NOT NULL CHECK (expires_at_epoch_ms > claimed_at_epoch_ms),
  FOREIGN KEY (queue_entry_id) REFERENCES laundry_queue_entry(id) ON DELETE CASCADE
);

CREATE INDEX laundry_queue_claim_active ON laundry_queue_claim
  (machine_id, appliance, expires_at_epoch_ms, queue_entry_id);

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
  UNIQUE (user_id, source_event_id),
  FOREIGN KEY (user_id) REFERENCES app_user(id) ON DELETE CASCADE
);

CREATE INDEX notification_user_history ON notification (user_id, created_at_epoch_ms DESC);

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

CREATE TABLE notification_delivery (
  notification_id TEXT NOT NULL,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('desktop', 'push')),
  target_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'retry', 'delivered', 'gone', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at_epoch_ms INTEGER,
  last_error TEXT,
  delivered_at_epoch_ms INTEGER,
  lease_token TEXT,
  lease_expires_at_epoch_ms INTEGER,
  CHECK ((lease_token IS NULL AND lease_expires_at_epoch_ms IS NULL)
    OR (lease_token IS NOT NULL AND lease_expires_at_epoch_ms IS NOT NULL)),
  PRIMARY KEY (notification_id, target_kind, target_id),
  FOREIGN KEY (notification_id) REFERENCES notification(id) ON DELETE CASCADE
);

CREATE INDEX notification_delivery_due ON notification_delivery
  (target_kind, status, next_attempt_at_epoch_ms, lease_expires_at_epoch_ms);

CREATE TRIGGER notification_delivery_fanout
AFTER INSERT ON notification
BEGIN
  INSERT OR IGNORE INTO notification_delivery
    (notification_id, target_kind, target_id, status, attempts, next_attempt_at_epoch_ms,
      last_error, delivered_at_epoch_ms, lease_token, lease_expires_at_epoch_ms)
  SELECT NEW.id, 'desktop', desktop.installation_id, 'pending', 0, NEW.due_at_epoch_ms,
    NULL, NULL, NULL, NULL
  FROM desktop_device desktop JOIN app_session session
    ON session.user_id = desktop.user_id AND session.installation_id = desktop.installation_id
  WHERE desktop.user_id = NEW.user_id AND session.kind = 'desktop'
    AND session.revoked_at_epoch_ms IS NULL AND session.expires_at_epoch_ms > NEW.created_at_epoch_ms;

  INSERT OR IGNORE INTO notification_delivery
    (notification_id, target_kind, target_id, status, attempts, next_attempt_at_epoch_ms,
      last_error, delivered_at_epoch_ms, lease_token, lease_expires_at_epoch_ms)
  SELECT NEW.id, 'push', subscription.id, 'pending', 0, NEW.due_at_epoch_ms,
    NULL, NULL, NULL, NULL
  FROM push_subscription subscription JOIN app_session session ON session.id = subscription.session_id
  WHERE subscription.user_id = NEW.user_id AND subscription.revoked_at_epoch_ms IS NULL
    AND session.kind = 'mobile' AND session.user_id = subscription.user_id
    AND session.revoked_at_epoch_ms IS NULL AND session.expires_at_epoch_ms > NEW.created_at_epoch_ms;
END;
