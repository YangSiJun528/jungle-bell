//! 분석 모듈 — PostHog 이벤트 수집.
//!
//! CMS 사용자 ID는 SHA-256으로 해시하여 distinct_id로 사용한다.
//! 로그인 전에는 "anonymous" 고정값을 사용한다.
//!
//! 추적 이벤트:
//!   - `app_opened`: 앱 실행 후 LMS 사용자 식별자가 준비될 때
//!   - `app_updated`: 앱 버전 변경 감지 후 LMS 사용자 식별자가 준비될 때
//!   - `onboarding_started`: 온보딩 창이 열릴 때
//!   - `onboarding_completed`: 온보딩 마지막 단계에서 시작하기를 누를 때
//!   - `onboarding_closed_before_complete`: 온보딩 완료 전에 창을 닫을 때
//!   - `usage_analytics_toggled`: 사용 통계 토글을 변경할 때
//!   - `settings_opened`: 트레이에서 설정 창 열 때
//!   - `attendance_page_opened`: 트레이에서 출석 페이지 열 때
//!   - `attendance_completed`: 출석 상태가 false→true로 전이할 때 (period=morning|evening)
//!   - `meal_plan_opened`: 트레이에서 식단표 보러가기 클릭 시

use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use tokio::sync::OnceCell;

static CLIENT: OnceCell<posthog_rs::Client> = OnceCell::const_new();
static DISTINCT_ID: OnceLock<String> = OnceLock::new();
static OS_NAME: OnceLock<String> = OnceLock::new();
static PENDING_APP_UPDATED: OnceLock<(String, String)> = OnceLock::new();
static USER_ENABLED: AtomicBool = AtomicBool::new(true);
static APP_OPENED_SENT: AtomicBool = AtomicBool::new(false);
static APP_UPDATED_SENT: AtomicBool = AtomicBool::new(false);

/// PostHog 이벤트 수집용 Project API Key.
///
/// 이 키는 공개해도 안전하다. PostHog의 Project API Key는 이벤트 전송 전용으로
/// 설계되어 있으며, 프론트엔드 JS·모바일 앱 등에 하드코딩하는 것이 표준 방식이다.
/// 대시보드 접근·데이터 조회 권한이 없는 Personal API Key와는 다르다.
/// 참고: https://posthog.com/docs/api#authentication
const API_KEY: Option<&str> = Some("phc_oinkQXTbUdqUVtfVeF5CwkB9An8uDViHX4buoYcsvZ96");

/// 앱 버전 (컴파일 시 Cargo에서 주입).
const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

/// 런타임 OS 이름을 최초 호출 시 수집해 캐시한다.
/// PostHog 표준 프로퍼티(`$os`)에 매핑해 대시보드에서 자동 인식되도록 한다.
fn os_name() -> &'static str {
    OS_NAME.get_or_init(|| os_info::get().os_type().to_string())
}

/// 개발 빌드(`cargo tauri dev` 등 `debug_assertions`이 켜진 빌드)에서는
/// PostHog 이벤트를 보내지 않는다. 릴리스 빌드(`cargo tauri build`)에서만 활성화된다.
fn is_build_enabled() -> bool {
    !cfg!(debug_assertions) && API_KEY.is_some()
}

fn is_enabled() -> bool {
    is_build_enabled() && USER_ENABLED.load(Ordering::Relaxed)
}

/// 분석 활성화 여부만 로깅한다. 실제 PostHog 클라이언트는 첫 이벤트 발사 시
/// `get_client()`에서 lazy 초기화되므로, 초기 이벤트가 경쟁 상태로 유실되지 않는다.
pub fn init(user_enabled: bool) {
    USER_ENABLED.store(user_enabled, Ordering::Relaxed);
    if is_enabled() {
        log::info!("[analytics] enabled (client will initialize on first event)");
    } else if is_build_enabled() {
        log::info!("[analytics] disabled (user setting)");
    } else {
        log::info!("[analytics] disabled (debug build)");
    }
}

pub fn set_user_enabled(enabled: bool) {
    USER_ENABLED.store(enabled, Ordering::Relaxed);
    log::info!("[analytics] user setting changed: {}", enabled);
}

pub fn prepare_app_updated(from_version: String, to_version: String) {
    let _ = PENDING_APP_UPDATED.set((from_version, to_version));
}

/// PostHog 클라이언트를 최초 호출 시 초기화하여 반환한다.
/// 이후 호출은 캐시된 인스턴스를 그대로 반환한다.
async fn get_client() -> Option<&'static posthog_rs::Client> {
    let api_key = API_KEY?;
    Some(
        CLIENT
            .get_or_init(|| async {
                log::info!("[analytics] initializing posthog client");
                posthog_rs::client(api_key).await
            })
            .await,
    )
}

/// CMS 사용자 ID를 SHA-256으로 해시하여 distinct_id 설정.
/// 최초 설정 시에만 적용하고, 이후 호출은 무시한다.
pub fn set_identity(cms_user_id: &str) {
    let hash = sha256_hex(cms_user_id);
    if DISTINCT_ID.set(hash).is_ok() {
        log::info!("[analytics] identity prepared");
    }
    track_startup_events();
}

/// 이벤트 전송 (fire-and-forget).
/// - 로그인 상태: hashed CMS ID 사용
/// - 미로그인 상태: "anonymous" 고정값 사용
fn capture(event_name: &'static str, extra_props: &[(&'static str, &str)]) {
    if !is_enabled() {
        return;
    }

    let distinct_id = DISTINCT_ID.get().cloned().unwrap_or_else(|| "anonymous".to_owned());

    let mut event = posthog_rs::Event::new(event_name, &distinct_id);
    if let Err(e) = event.insert_prop("app_version", APP_VERSION) {
        // 프로퍼티 삽입 실패는 이벤트 자체를 버릴 만큼 치명적이지 않다.
        // 로그만 남기고 전송은 계속 진행한다.
        log::debug!("[analytics] insert_prop 'app_version' failed: {}", e);
    }
    if let Err(e) = event.insert_prop("$os", os_name()) {
        log::debug!("[analytics] insert_prop '$os' failed: {}", e);
    }
    for (key, value) in extra_props {
        if let Err(e) = event.insert_prop(*key, *value) {
            log::debug!("[analytics] insert_prop '{}' failed: {}", key, e);
        }
    }

    tauri::async_runtime::spawn(async move {
        let Some(client) = get_client().await else { return };
        if let Err(e) = client.capture(event).await {
            log::warn!("[analytics] capture '{}' failed: {}", event_name, e);
        }
    });
}

pub fn track_startup_events() {
    track_app_opened();
    if let Some((from_version, to_version)) = PENDING_APP_UPDATED.get() {
        track_app_updated(from_version, to_version);
    }
}

pub fn track_app_opened() {
    if !is_enabled() || APP_OPENED_SENT.swap(true, Ordering::Relaxed) {
        return;
    }
    capture("app_opened", &[]);
}

pub fn track_app_updated(from_version: &str, to_version: &str) {
    if !is_enabled() || APP_UPDATED_SENT.swap(true, Ordering::Relaxed) {
        return;
    }
    capture(
        "app_updated",
        &[("from_version", from_version), ("to_version", to_version)],
    );
}

pub fn track_onboarding_started() {
    capture("onboarding_started", &[]);
}

pub fn track_onboarding_completed() {
    capture("onboarding_completed", &[]);
}

pub fn track_onboarding_closed_before_complete() {
    capture("onboarding_closed_before_complete", &[]);
}

pub fn track_usage_analytics_toggled(enabled: bool) {
    let enabled = if enabled { "true" } else { "false" };
    capture("usage_analytics_toggled", &[("enabled", enabled)]);
}

pub fn track_settings_opened() {
    capture("settings_opened", &[]);
}

pub fn track_attendance_page_opened() {
    capture("attendance_page_opened", &[]);
}

pub fn track_meal_plan_opened() {
    capture("meal_plan_opened", &[]);
}

pub fn track_feedback_opened() {
    capture("feedback_opened", &[]);
}

/// 출석 완료 이벤트. `period`는 "morning" 또는 "evening".
/// 스케줄러 틱마다가 아니라 morning/evening 상태가 false→true로 전이할 때만 호출한다.
pub fn track_attendance_completed(period: &'static str) {
    capture("attendance_completed", &[("period", period)]);
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
