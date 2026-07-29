//! 분석 모듈 — PostHog 이벤트 수집.
//!
//! CMS 사용자 ID는 SHA-256으로 해시하여 distinct_id로 사용한다.
//! 로그인 전에는 "anonymous" 고정값을 사용한다.
//!
//! 추적 이벤트:
//!   - `app_opened`: 앱 실행 후 LMS 사용자 식별자가 준비될 때
//!   - `app_updated`: 앱 버전 변경 감지 후 LMS 사용자 식별자가 준비될 때
//!   - `onboarding_started`: 온보딩 창이 열릴 때
//!   - `onboarding_completed`: 온보딩 마지막 화면에 도달할 때
//!   - `usage_analytics_toggled`: 사용 통계 토글을 변경할 때
//!   - `settings_opened`: 트레이에서 설정 창 열 때
//!   - `attendance_page_opened`: 트레이에서 출석 페이지 열 때
//!   - `laundry_status_opened`: 트레이에서 워시타워 현황을 열 때
//!   - `attendance_completed`: 출석 상태가 false→true로 전이할 때 (period=morning|evening)
//!   - `meal_plan_opened`: 트레이에서 식단표 보러가기 클릭 시
//!   - `setting_changed`: 앱 설정값을 변경할 때
//!   - `campus_interaction`: 생활정보 화면에서 주요 기능을 사용할 때

use serde::Deserialize;
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

pub enum Event {
    AppOpened,
    AppUpdated { from_version: String, to_version: String },
    OnboardingStarted,
    OnboardingCompleted,
    UsageAnalyticsToggled(bool),
    SettingsOpened,
    AttendancePageOpened,
    LaundryStatusOpened,
    MealPlanOpened,
    FeedbackOpened,
    AttendanceCompleted(AttendancePeriod),
    SettingChanged(Setting),
    CampusInteraction(CampusInteraction),
}

pub enum AttendancePeriod {
    Morning,
    Evening,
}

pub enum Setting {
    AutoStart(bool),
    StartNotificationEnabled(bool),
    EndNotificationEnabled(bool),
    NotificationStart { hour: u32, minute: u32 },
    NotificationEnd { hour: u32, minute: u32 },
    SkipAttendance(bool),
    SkipSunday(bool),
    DebugMode(bool),
    ShowDday(bool),
    ShowAppIcon(bool),
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LaundryAccess {
    All,
    Men,
    Women,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LaundryFilter {
    All,
    WasherAvailable,
    DryerAvailable,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CalendarDirection {
    Previous,
    Next,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(tag = "action", content = "value", rename_all = "snake_case", deny_unknown_fields)]
pub enum CampusInteraction {
    LaundryTabSelected,
    MealsTabSelected,
    LaundryAccessChanged(LaundryAccess),
    LaundryFilterChanged(LaundryFilter),
    MealHistoryOpened,
    MealCalendarNavigated(CalendarDirection),
    MealPostOpened,
    MealImageOpened,
    LaundryRefreshRequested,
    MealsRefreshRequested,
}

struct EventPayload {
    name: &'static str,
    properties: Vec<(&'static str, String)>,
}

impl Event {
    fn into_payload(self) -> EventPayload {
        let (name, properties) = match self {
            Self::AppOpened => ("app_opened", vec![]),
            Self::AppUpdated {
                from_version,
                to_version,
            } => (
                "app_updated",
                vec![("from_version", from_version), ("to_version", to_version)],
            ),
            Self::OnboardingStarted => ("onboarding_started", vec![]),
            Self::OnboardingCompleted => ("onboarding_completed", vec![]),
            Self::UsageAnalyticsToggled(enabled) => {
                ("usage_analytics_toggled", vec![("enabled", bool_value(enabled).into())])
            }
            Self::SettingsOpened => ("settings_opened", vec![]),
            Self::AttendancePageOpened => ("attendance_page_opened", vec![]),
            Self::LaundryStatusOpened => ("laundry_status_opened", vec![]),
            Self::MealPlanOpened => ("meal_plan_opened", vec![]),
            Self::FeedbackOpened => ("feedback_opened", vec![]),
            Self::AttendanceCompleted(period) => ("attendance_completed", vec![("period", period.as_str().into())]),
            Self::SettingChanged(setting) => {
                let (setting, value) = setting.into_parts();
                ("setting_changed", vec![("setting", setting.into()), ("value", value)])
            }
            Self::CampusInteraction(interaction) => {
                let (action, value) = interaction.into_parts();
                let mut properties = vec![("action", action.into())];
                if let Some(value) = value {
                    properties.push(("value", value.into()));
                }
                ("campus_interaction", properties)
            }
        };
        EventPayload { name, properties }
    }
}

impl AttendancePeriod {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Morning => "morning",
            Self::Evening => "evening",
        }
    }
}

impl Setting {
    fn into_parts(self) -> (&'static str, String) {
        match self {
            Self::AutoStart(value) => ("auto_start", bool_value(value).into()),
            Self::StartNotificationEnabled(value) => ("start_notification_enabled", bool_value(value).into()),
            Self::EndNotificationEnabled(value) => ("end_notification_enabled", bool_value(value).into()),
            Self::NotificationStart { hour, minute } => ("notification_start", time_value(hour, minute)),
            Self::NotificationEnd { hour, minute } => ("notification_end", time_value(hour, minute)),
            Self::SkipAttendance(value) => ("skip_attendance", bool_value(value).into()),
            Self::SkipSunday(value) => ("skip_sunday", bool_value(value).into()),
            Self::DebugMode(value) => ("debug_mode", bool_value(value).into()),
            Self::ShowDday(value) => ("show_dday", bool_value(value).into()),
            Self::ShowAppIcon(value) => ("show_app_icon", bool_value(value).into()),
        }
    }
}

impl LaundryAccess {
    fn as_str(&self) -> &'static str {
        match self {
            Self::All => "all",
            Self::Men => "men",
            Self::Women => "women",
        }
    }
}

impl LaundryFilter {
    fn as_str(&self) -> &'static str {
        match self {
            Self::All => "all",
            Self::WasherAvailable => "washer_available",
            Self::DryerAvailable => "dryer_available",
        }
    }
}

impl CalendarDirection {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Previous => "previous",
            Self::Next => "next",
        }
    }
}

impl CampusInteraction {
    fn into_parts(self) -> (&'static str, Option<&'static str>) {
        match self {
            Self::LaundryTabSelected => ("laundry_tab_selected", None),
            Self::MealsTabSelected => ("meals_tab_selected", None),
            Self::LaundryAccessChanged(value) => ("laundry_access_changed", Some(value.as_str())),
            Self::LaundryFilterChanged(value) => ("laundry_filter_changed", Some(value.as_str())),
            Self::MealHistoryOpened => ("meal_history_opened", None),
            Self::MealCalendarNavigated(value) => ("meal_calendar_navigated", Some(value.as_str())),
            Self::MealPostOpened => ("meal_post_opened", None),
            Self::MealImageOpened => ("meal_image_opened", None),
            Self::LaundryRefreshRequested => ("laundry_refresh_requested", None),
            Self::MealsRefreshRequested => ("meals_refresh_requested", None),
        }
    }
}

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

/// enum으로 정의된 이벤트를 전송한다 (fire-and-forget).
/// - 로그인 상태: hashed CMS ID 사용
/// - 미로그인 상태: "anonymous" 고정값 사용
pub fn track(event: Event) {
    if !is_enabled() {
        return;
    }
    match &event {
        Event::AppOpened if APP_OPENED_SENT.swap(true, Ordering::Relaxed) => return,
        Event::AppUpdated { .. } if APP_UPDATED_SENT.swap(true, Ordering::Relaxed) => return,
        _ => {}
    }

    let distinct_id = DISTINCT_ID.get().cloned().unwrap_or_else(|| "anonymous".to_owned());
    let payload = event.into_payload();
    let event_name = payload.name;

    let mut event = posthog_rs::Event::new(event_name, &distinct_id);
    if let Err(e) = event.insert_prop("app_version", APP_VERSION) {
        // 프로퍼티 삽입 실패는 이벤트 자체를 버릴 만큼 치명적이지 않다.
        // 로그만 남기고 전송은 계속 진행한다.
        log::debug!("[analytics] insert_prop 'app_version' failed: {}", e);
    }
    if let Err(e) = event.insert_prop("$os", os_name()) {
        log::debug!("[analytics] insert_prop '$os' failed: {}", e);
    }
    for (key, value) in payload.properties {
        if let Err(e) = event.insert_prop(key, value) {
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
    track(Event::AppOpened);
    if let Some((from_version, to_version)) = PENDING_APP_UPDATED.get() {
        track(Event::AppUpdated {
            from_version: from_version.clone(),
            to_version: to_version.clone(),
        });
    }
}

fn bool_value(value: bool) -> &'static str {
    if value {
        "true"
    } else {
        "false"
    }
}

fn time_value(hour: u32, minute: u32) -> String {
    format!("{hour:02}:{minute:02}")
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

    #[test]
    fn boolean_event_properties_use_lowercase_strings() {
        assert_eq!(bool_value(true), "true");
        assert_eq!(bool_value(false), "false");
    }

    #[test]
    fn time_event_properties_use_24_hour_format() {
        assert_eq!(time_value(4, 0), "04:00");
        assert_eq!(time_value(23, 30), "23:30");
    }

    #[test]
    fn analytics_event_enum_owns_the_posthog_contract() {
        let cases = [
            (Event::AppOpened, "app_opened"),
            (
                Event::AppUpdated {
                    from_version: "0.4.1".into(),
                    to_version: "0.4.2".into(),
                },
                "app_updated",
            ),
            (Event::OnboardingStarted, "onboarding_started"),
            (Event::OnboardingCompleted, "onboarding_completed"),
            (Event::UsageAnalyticsToggled(true), "usage_analytics_toggled"),
            (Event::SettingsOpened, "settings_opened"),
            (Event::AttendancePageOpened, "attendance_page_opened"),
            (Event::LaundryStatusOpened, "laundry_status_opened"),
            (Event::MealPlanOpened, "meal_plan_opened"),
            (Event::FeedbackOpened, "feedback_opened"),
            (
                Event::AttendanceCompleted(AttendancePeriod::Morning),
                "attendance_completed",
            ),
            (Event::SettingChanged(Setting::ShowDday(true)), "setting_changed"),
            (
                Event::CampusInteraction(CampusInteraction::MealHistoryOpened),
                "campus_interaction",
            ),
        ];

        for (event, expected_name) in cases {
            assert_eq!(event.into_payload().name, expected_name);
        }
    }

    #[test]
    fn enum_payloads_generate_typed_properties() {
        let setting = Event::SettingChanged(Setting::NotificationStart { hour: 4, minute: 0 }).into_payload();
        assert_eq!(
            setting.properties,
            vec![("setting", "notification_start".into()), ("value", "04:00".into()),]
        );

        let campus = Event::CampusInteraction(CampusInteraction::LaundryFilterChanged(LaundryFilter::WasherAvailable))
            .into_payload();
        assert_eq!(
            campus.properties,
            vec![
                ("action", "laundry_filter_changed".into()),
                ("value", "washer_available".into()),
            ]
        );
    }

    #[test]
    fn campus_interaction_ipc_deserializes_only_known_enum_shapes() {
        let interaction: CampusInteraction = serde_json::from_value(serde_json::json!({
            "action": "laundry_access_changed",
            "value": "women"
        }))
        .unwrap();
        assert!(matches!(
            interaction,
            CampusInteraction::LaundryAccessChanged(LaundryAccess::Women)
        ));

        assert!(serde_json::from_value::<CampusInteraction>(serde_json::json!({
            "action": "laundry_access_changed",
            "value": "unknown"
        }))
        .is_err());
        assert!(serde_json::from_value::<CampusInteraction>(serde_json::json!({
            "action": "meal_post_opened",
            "value": "unexpected"
        }))
        .is_err());
    }
}
