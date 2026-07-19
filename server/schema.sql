-- This project supports only the current schema. Applying this file deletes all D1 data.
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
