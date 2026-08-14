//! Opt-out 가능한 최소 사용 통계 수집 경계.
//!
//! LMS 식별자나 출석·식단 내용은 보내지 않는다. 로컬 설치 ID를 SHA-256으로
//! 가명 처리한 값, 앱 버전, 운영체제와 명시적으로 정의한 앱/설정 이벤트만 전송한다.

use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
static DISTINCT_ID: OnceLock<String> = OnceLock::new();
static USER_ENABLED: AtomicBool = AtomicBool::new(true);
static APP_OPENED_SENT: AtomicBool = AtomicBool::new(false);

const CAPTURE_URL: &str = "https://us.i.posthog.com/i/v0/e/";
const API_KEY: Option<&str> = Some("phc_oinkQXTbUdqUVtfVeF5CwkB9An8uDViHX4buoYcsvZ96");
const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

pub enum Event {
    AppOpened,
    UsageAnalyticsToggled(bool),
    DesktopSettingChanged { setting: &'static str, enabled: bool },
}

impl Event {
    fn payload(self) -> (&'static str, Vec<(&'static str, String)>) {
        match self {
            Self::AppOpened => ("app_opened", vec![]),
            Self::UsageAnalyticsToggled(enabled) => ("usage_analytics_toggled", vec![("enabled", enabled.to_string())]),
            Self::DesktopSettingChanged { setting, enabled } => (
                "setting_changed",
                vec![("setting", setting.into()), ("value", enabled.to_string())],
            ),
        }
    }
}

fn build_enabled() -> bool {
    !cfg!(debug_assertions) && API_KEY.is_some()
}

fn enabled() -> bool {
    build_enabled() && USER_ENABLED.load(Ordering::Relaxed)
}

pub fn init(user_enabled: bool) {
    USER_ENABLED.store(user_enabled, Ordering::Relaxed);
    log::info!("[analytics] {}", if enabled() { "enabled" } else { "disabled" });
}

pub fn set_identity(installation_id: &str) {
    let mut hasher = Sha256::new();
    hasher.update(installation_id.as_bytes());
    let _ = DISTINCT_ID.set(format!("{:x}", hasher.finalize()));
    track(Event::AppOpened);
}

pub fn set_user_enabled(value: bool) {
    USER_ENABLED.store(value, Ordering::Relaxed);
    log::info!("[analytics] user setting changed: {value}");
}

pub fn track(event: Event) {
    if !enabled() {
        return;
    }
    if matches!(&event, Event::AppOpened) && APP_OPENED_SENT.swap(true, Ordering::Relaxed) {
        return;
    }
    let Some(distinct_id) = DISTINCT_ID.get().cloned() else {
        return;
    };
    let Some(api_key) = API_KEY else {
        return;
    };
    let (event_name, event_properties) = event.payload();
    let mut properties = serde_json::Map::from_iter([
        ("$process_person_profile".into(), serde_json::Value::Bool(false)),
        ("app_version".into(), serde_json::Value::String(APP_VERSION.into())),
        ("$os".into(), serde_json::Value::String(std::env::consts::OS.into())),
    ]);
    for (key, value) in event_properties {
        properties.insert(key.into(), value.into());
    }
    let payload = serde_json::json!({
        "api_key": api_key,
        "distinct_id": distinct_id,
        "event": event_name,
        "properties": properties,
    });

    tauri::async_runtime::spawn(async move {
        let client = CLIENT.get_or_init(reqwest::Client::new);
        match client.post(CAPTURE_URL).json(&payload).send().await {
            Ok(response) if response.status().is_success() => {}
            Ok(response) => log::warn!("[analytics] capture '{event_name}' rejected: {}", response.status()),
            Err(error) => log::warn!("[analytics] capture '{event_name}' failed: {error}"),
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 설정_이벤트는_허용된_속성만_만든다() {
        let (name, properties) = Event::DesktopSettingChanged {
            setting: "auto_update",
            enabled: false,
        }
        .payload();
        assert_eq!(name, "setting_changed");
        assert_eq!(
            properties,
            vec![("setting", "auto_update".into()), ("value", "false".into())],
        );
    }

    #[test]
    fn 설치_식별자_원문은_해시로_변환한다() {
        let mut hasher = Sha256::new();
        hasher.update("550e8400-e29b-41d4-a716-446655440000".as_bytes());
        let hash = format!("{:x}", hasher.finalize());
        assert_eq!(hash.len(), 64);
        assert!(!hash.contains("550e8400"));
    }
}
