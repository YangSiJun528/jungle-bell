//! 분석 모듈 — PostHog 이벤트 수집.
//!
//! 컴파일 시 `POSTHOG_API_KEY` 환경변수가 설정된 경우에만 활성화.
//! CMS 사용자 ID는 SHA-256으로 해시하여 distinct_id로 사용한다.
//! 로그인 전에는 "anonymous" 고정값을 사용한다.
//!
//! 추적 이벤트:
//!   - `settings_opened`: 트레이에서 설정 창 열 때
//!   - `attendance_page_opened`: 트레이에서 출석 페이지 열 때
//!   - `attendance_check_attempted`: 출석 체크 시도 시

use sha2::{Digest, Sha256};
use std::sync::Mutex;
use tokio::sync::OnceCell;

static CLIENT: OnceCell<posthog_rs::Client> = OnceCell::const_new();
static DISTINCT_ID: Mutex<Option<String>> = Mutex::new(None);

/// PostHog API 키 (컴파일 시 환경변수). 미설정 시 분석 비활성화.
const API_KEY: Option<&str> = option_env!("POSTHOG_API_KEY");

/// PostHog 클라이언트를 비동기로 초기화한다. API 키가 없으면 no-op.
pub fn init() {
    let Some(api_key) = API_KEY else {
        log::info!("[analytics] POSTHOG_API_KEY not set, analytics disabled");
        return;
    };

    let api_key = api_key.to_owned();
    tauri::async_runtime::spawn(async move {
        let client = posthog_rs::client(api_key.as_str()).await;
        CLIENT.set(client).ok();
        log::info!("[analytics] initialized");
    });
}

/// CMS 사용자 ID를 SHA-256으로 해시하여 distinct_id 설정.
/// 최초 설정 시에만 적용하고, 이후 호출은 무시한다.
pub fn set_identity(cms_user_id: &str) {
    let hash = sha256_hex(cms_user_id);
    if let Ok(mut id) = DISTINCT_ID.lock() {
        if id.is_none() {
            log::info!("[analytics] identity set (hash={}...)", &hash[..8]);
            *id = Some(hash);
        }
    }
}

/// 이벤트 전송 (fire-and-forget).
/// - 로그인 상태: hashed CMS ID 사용
/// - 미로그인 상태: "anonymous" 고정값 사용
fn capture(event_name: &str, app_version: &str) {
    if API_KEY.is_none() {
        return;
    }

    let distinct_id = DISTINCT_ID
        .lock()
        .ok()
        .and_then(|g| g.clone())
        .unwrap_or_else(|| "anonymous".to_owned());

    let mut event = posthog_rs::Event::new(event_name, &distinct_id);
    if let Err(e) = event.insert_prop("app_version", app_version) {
        log::debug!("[analytics] insert_prop failed: {}", e);
        return;
    }

    let event_name = event_name.to_owned();
    tauri::async_runtime::spawn(async move {
        let Some(client) = CLIENT.get() else { return };
        if let Err(e) = client.capture(event).await {
            log::warn!("[analytics] capture '{}' failed: {}", event_name, e);
        }
    });
}

pub fn track_settings_opened(app_version: &str) {
    capture("settings_opened", app_version);
}

pub fn track_attendance_page_opened(app_version: &str) {
    capture("attendance_page_opened", app_version);
}

pub fn track_attendance_check(app_version: &str) {
    capture("attendance_check_attempted", app_version);
}

fn sha256_hex(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    format!("{:x}", hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_produces_deterministic_hex() {
        let hash = sha256_hex("d0439dcc-4bf2-4996-ab47-dd5aeab587dc");
        assert_eq!(hash.len(), 64);
        assert_eq!(hash, sha256_hex("d0439dcc-4bf2-4996-ab47-dd5aeab587dc"));
    }

    #[test]
    fn sha256_different_inputs_produce_different_hashes() {
        assert_ne!(sha256_hex("user-a"), sha256_hex("user-b"));
    }
}
