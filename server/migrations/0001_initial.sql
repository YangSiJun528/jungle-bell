CREATE TABLE IF NOT EXISTS source_state (
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

CREATE TABLE IF NOT EXISTS source_version (
  source TEXT NOT NULL,
  sha TEXT NOT NULL,
  first_observed_at TEXT NOT NULL,
  raw_key TEXT NOT NULL,
  normalized_key TEXT,
  PRIMARY KEY (source, sha)
);

CREATE TABLE IF NOT EXISTS minute_observation (
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

CREATE INDEX IF NOT EXISTS minute_observation_collected_at
  ON minute_observation (collected_at);

CREATE TABLE IF NOT EXISTS laundry_event (
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

CREATE INDEX IF NOT EXISTS laundry_event_observed_at
  ON laundry_event (observed_at DESC);

CREATE INDEX IF NOT EXISTS laundry_event_machine_session
  ON laundry_event (machine_id, appliance, session_id, observed_at);
