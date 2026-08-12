-- Apply once before deploying the direct desktop WebView HTTP client. This only
-- adds an origin-bound short-lived capability table; existing account and session
-- rows are unchanged.
CREATE TABLE IF NOT EXISTS desktop_ui_session (
  id TEXT PRIMARY KEY,
  parent_session_id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  token_sha256 TEXT NOT NULL UNIQUE CHECK (length(token_sha256) = 64),
  origin TEXT NOT NULL CHECK (origin IN (
    'tauri://localhost',
    'http://tauri.localhost',
    'http://127.0.0.1:5173'
  )),
  scope TEXT NOT NULL CHECK (scope = 'desktop-ui-v1'),
  created_at_epoch_ms INTEGER NOT NULL,
  expires_at_epoch_ms INTEGER NOT NULL CHECK (expires_at_epoch_ms > created_at_epoch_ms),
  FOREIGN KEY (parent_session_id) REFERENCES app_session(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES app_user(id) ON DELETE CASCADE,
  FOREIGN KEY (installation_id) REFERENCES desktop_device(installation_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS desktop_ui_session_expiry
  ON desktop_ui_session (expires_at_epoch_ms);
