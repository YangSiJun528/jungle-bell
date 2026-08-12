-- Apply once to an existing jungle-bell-v2 D1 before deploying code that reads
-- account-level attendance notification schedules. Every existing row keeps its
-- old switches and skip values; the new fields receive legacy-compatible defaults.
ALTER TABLE attendance_preference
  ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1));
ALTER TABLE attendance_preference
  ADD COLUMN morning_start_hour INTEGER NOT NULL DEFAULT 9 CHECK (morning_start_hour BETWEEN 4 AND 9);
ALTER TABLE attendance_preference
  ADD COLUMN evening_end_hour INTEGER NOT NULL DEFAULT 4 CHECK (evening_end_hour BETWEEN 0 AND 4);
ALTER TABLE attendance_preference
  ADD COLUMN morning_interval_minutes INTEGER NOT NULL DEFAULT 15
    CHECK (morning_interval_minutes IN (1, 3, 5, 10, 15, 30));
ALTER TABLE attendance_preference
  ADD COLUMN evening_interval_minutes INTEGER NOT NULL DEFAULT 15
    CHECK (evening_interval_minutes IN (1, 3, 5, 10, 15, 30));

CREATE INDEX IF NOT EXISTS attendance_preference_morning_subscriber
  ON attendance_preference(enabled, morning_enabled, user_id);
CREATE INDEX IF NOT EXISTS attendance_preference_evening_subscriber
  ON attendance_preference(enabled, evening_enabled, user_id);
