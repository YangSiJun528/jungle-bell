#!/usr/bin/env bash
set -euo pipefail

base_url="${1:-http://127.0.0.1:8080}"
postgres_container="${POSTGRES_CONTAINER:-jungle-bell-postgres-v2-test}"
installation_id="smoke-$(openssl rand -hex 8)"
work_dir="$(mktemp -d)"

cleanup() {
  user_id="$(docker exec "$postgres_container" psql -U jungle_bell -d jungle_bell \
    -Atc "SELECT user_id FROM desktop_device WHERE installation_id = '$installation_id'" 2>/dev/null || true)"
  if [[ -n "$user_id" ]]; then
    docker exec "$postgres_container" psql -U jungle_bell -d jungle_bell \
      -c "DELETE FROM app_user WHERE id = '$user_id'::uuid" >/dev/null
  fi
  rm -rf "$work_dir"
}
trap cleanup EXIT

request() {
  local expected="$1"
  local output="$2"
  shift 2
  local actual
  actual="$(curl --silent --show-error --output "$output" --write-out '%{http_code}' "$@")"
  [[ "$actual" == "$expected" ]] || {
    printf 'expected HTTP %s, got %s for %s\n' "$expected" "$actual" "$*" >&2
    sed -n '1,20p' "$output" >&2
    exit 1
  }
}

request 201 "$work_dir/enrollment.json" \
  -H 'content-type: application/json' \
  -d "{\"installationId\":\"$installation_id\"}" \
  "$base_url/api/desktop/installations"
desktop_token="$(jq -r '.accessToken' "$work_dir/enrollment.json")"
[[ "$desktop_token" == jbd_* ]]

request 201 "$work_dir/ui-session.json" \
  -H "authorization: Bearer $desktop_token" \
  -H 'content-type: application/json' \
  -d '{"origin":"tauri://localhost"}' \
  "$base_url/api/desktop/webview-sessions"
ui_token="$(jq -r '.accessToken' "$work_dir/ui-session.json")"
[[ "$ui_token" == jbui_* ]]

desktop_ui_headers=(
  -H "authorization: Bearer $ui_token"
  -H 'origin: tauri://localhost'
)

request 200 "$work_dir/attendance.json" \
  "${desktop_ui_headers[@]}" "$base_url/api/desktop-ui/attendance"
[[ "$(jq -r '.freshness' "$work_dir/attendance.json")" == 'missing' ]]

request 200 "$work_dir/meal-preferences.json" \
  "${desktop_ui_headers[@]}" "$base_url/api/desktop-ui/meal-preferences"
[[ "$(jq -r '.lunch' "$work_dir/meal-preferences.json")" == 'true' ]]
[[ "$(jq -r '.dinner' "$work_dir/meal-preferences.json")" == 'true' ]]
[[ "$(jq -r 'has("breakfast")' "$work_dir/meal-preferences.json")" == 'false' ]]

request 200 "$work_dir/watches.json" \
  "${desktop_ui_headers[@]}" "$base_url/api/desktop-ui/laundry-watches"
[[ "$(jq -r '.watches | length' "$work_dir/watches.json")" == '0' ]]

request 200 "$work_dir/mobile-sessions.json" \
  "${desktop_ui_headers[@]}" "$base_url/api/desktop-ui/mobile-sessions"
[[ "$(jq -r '.devices | length' "$work_dir/mobile-sessions.json")" == '0' ]]

request 200 "$work_dir/heartbeat.json" \
  -H "authorization: Bearer $desktop_token" \
  -H 'content-type: application/json' \
  -d '{"lmsSessionState":"login-required","appVersion":"smoke"}' \
  "$base_url/api/desktop/heartbeat"

request 403 "$work_dir/evil-origin.json" \
  -H "authorization: Bearer $ui_token" \
  -H 'origin: https://evil.example' \
  "$base_url/api/desktop-ui/attendance"

cleanup
trap - EXIT

printf '%s\n' \
  'enrollment=201' \
  'desktopUiSession=201' \
  'attendance=200 missing' \
  'mealPreferences=200 lunch+dinner only' \
  'laundryWatches=200 empty' \
  'mobileSessions=200 empty' \
  'heartbeat=200' \
  'evilOrigin=403' \
  'testAccount=deleted'
