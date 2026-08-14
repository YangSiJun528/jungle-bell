CREATE TABLE IF NOT EXISTS maintenance_state (
    name text PRIMARY KEY,
    last_run_at_epoch_ms bigint NOT NULL,
    run_token text NOT NULL
);

CREATE TABLE IF NOT EXISTS source_state (
    source text PRIMARY KEY CHECK (source IN ('laundry', 'meals-include-pinned', 'meals-default')),
    last_attempt_at timestamptz NOT NULL,
    last_success_at timestamptz,
    last_response_sha char(64),
    version_first_seen_at timestamptz,
    consecutive_failures integer NOT NULL DEFAULT 0,
    last_error text
);

CREATE TABLE IF NOT EXISTS laundry_version (
    sha char(64) PRIMARY KEY,
    normalized jsonb NOT NULL,
    first_seen_at timestamptz NOT NULL,
    last_seen_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS minute_observation (
    source text NOT NULL,
    minute_epoch bigint NOT NULL,
    scheduled_at timestamptz NOT NULL,
    collected_at timestamptz NOT NULL,
    status text NOT NULL CHECK (status IN ('SUCCESS', 'FAILED', 'GAP')),
    version_sha char(64) REFERENCES laundry_version(sha),
    version_first_seen_at timestamptz,
    changed boolean NOT NULL,
    duration_ms bigint NOT NULL CHECK (duration_ms >= 0),
    http_status integer,
    error text,
    PRIMARY KEY (source, minute_epoch)
);

CREATE INDEX IF NOT EXISTS minute_observation_collected_at
    ON minute_observation (collected_at DESC);

CREATE TABLE IF NOT EXISTS laundry_event (
    id uuid PRIMARY KEY,
    machine_id text NOT NULL,
    appliance text NOT NULL CHECK (appliance IN ('washer', 'dryer')),
    session_id text,
    type text NOT NULL,
    previous_observed_at timestamptz,
    observed_at timestamptz NOT NULL,
    eta_delta_minutes double precision,
    previous_state text,
    current_state text NOT NULL,
    detail jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS laundry_event_observed_at
    ON laundry_event (observed_at DESC);
CREATE INDEX IF NOT EXISTS laundry_event_machine_session
    ON laundry_event (machine_id, appliance, session_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS meal_post (
    id text PRIMARY KEY,
    kind text NOT NULL CHECK (kind IN ('PINNED_MENU', 'DAILY_MENU', 'OTHER')),
    content_sha char(64) NOT NULL,
    title text,
    body text NOT NULL,
    pinned boolean NOT NULL,
    published_at timestamptz,
    updated_at timestamptz,
    permalink text,
    status text,
    first_seen_at timestamptz NOT NULL,
    content_first_seen_at timestamptz NOT NULL,
    last_seen_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS meal_post_published_at ON meal_post (published_at DESC);
CREATE INDEX IF NOT EXISTS meal_post_kind_published_at ON meal_post (kind, published_at DESC);

CREATE TABLE IF NOT EXISTS meal_image (
    post_id text NOT NULL REFERENCES meal_post(id) ON DELETE CASCADE,
    media_id text NOT NULL,
    position integer NOT NULL CHECK (position >= 0),
    source_url text NOT NULL,
    declared_content_type text,
    filename text,
    width integer,
    height integer,
    sha char(64) NOT NULL,
    content_type text NOT NULL,
    extension text NOT NULL,
    byte_length bigint NOT NULL CHECK (byte_length >= 0),
    content bytea NOT NULL,
    PRIMARY KEY (post_id, media_id)
);

CREATE INDEX IF NOT EXISTS meal_image_post_position ON meal_image (post_id, position);
CREATE INDEX IF NOT EXISTS meal_image_sha ON meal_image (sha);

CREATE TABLE IF NOT EXISTS meal_weekly_menu (
    week_key date PRIMARY KEY,
    content_sha char(64) NOT NULL,
    post_id text NOT NULL REFERENCES meal_post(id) ON DELETE CASCADE,
    updated_at timestamptz,
    observed_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS meal_weekly_menu_updated_at ON meal_weekly_menu (updated_at DESC);

CREATE TABLE IF NOT EXISTS app_user (
    id uuid PRIMARY KEY,
    created_at_epoch_ms bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS desktop_enrollment_attempt (
    rate_key char(64) PRIMARY KEY,
    window_started_at_epoch_ms bigint NOT NULL,
    attempt_count integer NOT NULL CHECK (attempt_count > 0)
);

CREATE TABLE IF NOT EXISTS desktop_device (
    installation_id text PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    created_at_epoch_ms bigint NOT NULL,
    activated_at_epoch_ms bigint,
    last_seen_at_epoch_ms bigint,
    lms_session_state text NOT NULL CHECK (lms_session_state IN ('connected', 'login-required', 'unknown')),
    app_version text
);

CREATE INDEX IF NOT EXISTS desktop_device_user ON desktop_device (user_id);

CREATE TABLE IF NOT EXISTS app_session (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    installation_id text NOT NULL,
    kind text NOT NULL CHECK (kind IN ('desktop', 'mobile')),
    label text,
    token_sha256 char(64) NOT NULL UNIQUE,
    created_at_epoch_ms bigint NOT NULL,
    expires_at_epoch_ms bigint NOT NULL,
    last_seen_at_epoch_ms bigint NOT NULL,
    revoked_at_epoch_ms bigint,
    source_pairing_id uuid UNIQUE
);

CREATE INDEX IF NOT EXISTS app_session_user_kind
    ON app_session (user_id, kind, created_at_epoch_ms DESC);
CREATE UNIQUE INDEX IF NOT EXISTS app_session_active_desktop_installation
    ON app_session (installation_id) WHERE kind = 'desktop' AND revoked_at_epoch_ms IS NULL;

CREATE TABLE IF NOT EXISTS desktop_ui_session (
    id uuid PRIMARY KEY,
    parent_session_id uuid NOT NULL UNIQUE REFERENCES app_session(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    installation_id text NOT NULL REFERENCES desktop_device(installation_id) ON DELETE CASCADE,
    token_sha256 char(64) NOT NULL UNIQUE,
    origin text NOT NULL,
    scope text NOT NULL CHECK (scope = 'desktop-ui-v1'),
    created_at_epoch_ms bigint NOT NULL,
    expires_at_epoch_ms bigint NOT NULL CHECK (expires_at_epoch_ms > created_at_epoch_ms)
);

CREATE INDEX IF NOT EXISTS desktop_ui_session_expiry ON desktop_ui_session (expires_at_epoch_ms);

CREATE TABLE IF NOT EXISTS pairing_challenge (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    desktop_installation_id text NOT NULL REFERENCES desktop_device(installation_id) ON DELETE CASCADE,
    pairing_secret_sha256 char(64) NOT NULL UNIQUE,
    manual_code_hash char(64) NOT NULL UNIQUE,
    claim_receipt_sha256 char(64) UNIQUE,
    status text NOT NULL CHECK (status IN ('pending', 'claimed', 'approved', 'consumed')),
    mobile_installation_id text,
    mobile_label text,
    created_at_epoch_ms bigint NOT NULL,
    expires_at_epoch_ms bigint NOT NULL,
    approved_at_epoch_ms bigint
);

CREATE INDEX IF NOT EXISTS pairing_challenge_expiry ON pairing_challenge (expires_at_epoch_ms);

CREATE TABLE IF NOT EXISTS attendance_snapshot (
    user_id uuid PRIMARY KEY REFERENCES app_user(id) ON DELETE CASCADE,
    source_installation_id text NOT NULL,
    attendance_date date NOT NULL,
    cohort_id text,
    cohort_status text NOT NULL CHECK (cohort_status IN ('active', 'upcoming', 'ended', 'none', 'unknown')),
    cohort_start_date date,
    cohort_end_date date,
    morning_checked boolean NOT NULL,
    evening_checked boolean NOT NULL,
    collected_at_epoch_ms bigint NOT NULL,
    received_at_epoch_ms bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS attendance_preference (
    user_id uuid PRIMARY KEY REFERENCES app_user(id) ON DELETE CASCADE,
    enabled boolean NOT NULL DEFAULT true,
    morning_enabled boolean NOT NULL DEFAULT true,
    evening_enabled boolean NOT NULL DEFAULT true,
    morning_start_hour integer NOT NULL DEFAULT 9 CHECK (morning_start_hour BETWEEN 4 AND 9),
    evening_end_hour integer NOT NULL DEFAULT 4 CHECK (evening_end_hour BETWEEN 0 AND 4),
    morning_interval_minutes integer NOT NULL DEFAULT 15 CHECK (morning_interval_minutes IN (1, 3, 5, 10, 15, 30)),
    evening_interval_minutes integer NOT NULL DEFAULT 15 CHECK (evening_interval_minutes IN (1, 3, 5, 10, 15, 30)),
    skip_sunday boolean NOT NULL DEFAULT false,
    skip_attendance_date date,
    updated_at_epoch_ms bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS attendance_preference_morning_subscriber
    ON attendance_preference (enabled, morning_enabled, user_id);
CREATE INDEX IF NOT EXISTS attendance_preference_evening_subscriber
    ON attendance_preference (enabled, evening_enabled, user_id);

CREATE TABLE IF NOT EXISTS meal_preference (
    user_id uuid PRIMARY KEY REFERENCES app_user(id) ON DELETE CASCADE,
    enabled boolean NOT NULL,
    lunch boolean NOT NULL,
    dinner boolean NOT NULL,
    updated_at_epoch_ms bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS laundry_watch (
    id text PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    machine_id text NOT NULL CHECK (length(machine_id) BETWEEN 1 AND 128),
    appliance text NOT NULL CHECK (appliance IN ('washer', 'dryer')),
    session_id text,
    notify_before_minutes integer NOT NULL CHECK (notify_before_minutes BETWEEN 0 AND 180),
    notify_when_available boolean NOT NULL,
    status text NOT NULL CHECK (status IN ('active', 'completed', 'cancelled')),
    created_at_epoch_ms bigint NOT NULL,
    updated_at_epoch_ms bigint NOT NULL CHECK (updated_at_epoch_ms >= created_at_epoch_ms)
);

CREATE INDEX IF NOT EXISTS laundry_watch_user_history
    ON laundry_watch (user_id, created_at_epoch_ms DESC, id);
CREATE INDEX IF NOT EXISTS laundry_watch_active_target
    ON laundry_watch (machine_id, appliance, session_id, user_id) WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS laundry_watch_active_dedupe
    ON laundry_watch (user_id, machine_id, appliance, COALESCE(session_id, ''), notify_when_available)
    WHERE status = 'active';

CREATE TABLE IF NOT EXISTS notification (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    source_event_id text NOT NULL,
    kind text NOT NULL,
    title text NOT NULL,
    body text NOT NULL,
    path text NOT NULL,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at_epoch_ms bigint NOT NULL,
    due_at_epoch_ms bigint NOT NULL,
    expires_at_epoch_ms bigint NOT NULL,
    UNIQUE (user_id, source_event_id)
);

CREATE INDEX IF NOT EXISTS notification_user_history ON notification (user_id, created_at_epoch_ms DESC);

CREATE TABLE IF NOT EXISTS push_subscription (
    id text PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    session_id uuid NOT NULL REFERENCES app_session(id) ON DELETE CASCADE,
    endpoint text NOT NULL,
    p256dh text NOT NULL,
    auth text NOT NULL,
    created_at_epoch_ms bigint NOT NULL,
    revoked_at_epoch_ms bigint
);

CREATE INDEX IF NOT EXISTS push_subscription_user ON push_subscription (user_id, revoked_at_epoch_ms);

CREATE TABLE IF NOT EXISTS notification_delivery (
    notification_id uuid NOT NULL REFERENCES notification(id) ON DELETE CASCADE,
    target_kind text NOT NULL CHECK (target_kind IN ('desktop', 'push')),
    target_id text NOT NULL,
    status text NOT NULL CHECK (status IN ('pending', 'retry', 'delivered', 'gone', 'failed')),
    attempts integer NOT NULL DEFAULT 0,
    next_attempt_at_epoch_ms bigint,
    last_error text,
    delivered_at_epoch_ms bigint,
    lease_token text,
    lease_expires_at_epoch_ms bigint,
    PRIMARY KEY (notification_id, target_kind, target_id)
);

CREATE INDEX IF NOT EXISTS notification_delivery_due
    ON notification_delivery (target_kind, status, next_attempt_at_epoch_ms, lease_expires_at_epoch_ms);
