//! 커맨드 모듈 — 모든 Tauri invoke 핸들러.
//!
//! JS에서 `window.__TAURI__.core.invoke()`로 호출하는
//! 모든 커맨드 함수가 이 모듈에 정의된다.
//! 도메인 로직은 `checker`, `updater` 등 전용 모듈에 위임한다.

use std::sync::Arc;

use serde::{Deserialize, Deserializer, Serialize};
use tauri::{Emitter, Manager};
use tokio::sync::Mutex;

use crate::analytics::{self, Event};
use crate::attendance;
use crate::checker;
use crate::desktop_settings::DesktopSettingsService;
use crate::notification_inbox::{NotificationInboxService, NotificationInboxSnapshot};
use crate::notification_service::{NotificationRequest, NotificationService};
use crate::remote_sync::{self, RemoteSyncService};
use crate::state::{self, AppState};
use crate::tray;

const LMS_SESSION_STATE_UPDATED_EVENT: &str = "lms-session-state-updated";

// ── 연결 서비스 대시보드 경계 ───────────────────────────

#[tauri::command]
pub(crate) async fn bootstrap_desktop_http_session(
    window: tauri::WebviewWindow,
    service: tauri::State<'_, Arc<RemoteSyncService>>,
) -> Result<remote_sync::DesktopHttpSession, String> {
    remote_sync::bootstrap_desktop_http_session(window, service).await
}

#[tauri::command]
pub(crate) async fn get_connected_service_status(
    window: tauri::WebviewWindow,
    service: tauri::State<'_, Arc<RemoteSyncService>>,
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
) -> Result<remote_sync::ConnectedServiceStatus, String> {
    remote_sync::get_connected_service_status(window, service, state).await
}

#[tauri::command]
pub(crate) async fn reset_desktop_identity(
    window: tauri::WebviewWindow,
    service: tauri::State<'_, Arc<RemoteSyncService>>,
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
    confirmed: bool,
) -> Result<remote_sync::ConnectedServiceStatus, String> {
    remote_sync::reset_desktop_identity(window, service, state, confirmed).await
}

#[tauri::command]
pub(crate) fn open_lms_login(window: tauri::WebviewWindow, app: tauri::AppHandle) -> Result<(), String> {
    remote_sync::open_lms_login(window, app)
}

#[tauri::command]
pub(crate) async fn refresh_platform_sync(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    service: tauri::State<'_, Arc<RemoteSyncService>>,
) -> Result<(), String> {
    remote_sync::refresh_platform_sync(app, window, service).await
}

#[derive(Debug, serde::Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum CheckerEventInput {
    Ready {
        generation: u64,
    },
    Log {
        level: String,
        message: String,
    },
    ResolveCohort {
        cohort_options: Vec<attendance::CohortOption>,
    },
    AttendanceSnapshot {
        status: attendance::AttendanceReport,
    },
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum CheckerEventResponse {
    Acknowledged,
    CohortSelection { selection: attendance::CohortResolution },
}

// ── 출석 보고 ────────────────────────────────────────────

/// Tauri 커맨드: API 조회 결과를 수신.
/// `trigger_check()`가 이벤트를 보내면, JS가 이 커맨드를 invoke로 호출한다.
async fn handle_attendance_snapshot(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
    remote_sync_service: tauri::State<'_, Arc<RemoteSyncService>>,
    status: attendance::AttendanceReport,
) -> Result<(), String> {
    let mut s = state.lock().await;
    if status.generation == 0 || status.generation != s.checker.page_load_generation {
        return Err("CHECKER_GENERATION_INVALID".into());
    }
    let now = chrono::Utc::now();
    let previous_lms_session_state = remote_sync::lms_session_state(&s);
    let checker_actions = checker::record_checker_report(&mut s, status.generation, status.api_error);
    if checker_actions
        .iter()
        .any(|action| matches!(action, checker::CheckerAction::IgnoreStale { .. }))
    {
        log::warn!(
            "[checker] stale report ignored: generation={} current_generation={}",
            status.generation,
            s.checker.page_load_generation,
        );
        return Ok(());
    }
    if status.api_error {
        log::info!("[checker] API error received, skipping state update");
    } else {
        log::info!(
            "[checker] report: needs_login={} morning={} evening={} current_phase={:?}",
            status.needs_login,
            status.morning_done,
            status.evening_done,
            s.phase,
        );
    }
    log::debug!("[checker] report received for generation={}", status.generation);

    // 전이 감지를 위해 이전 상태 보존.
    // `was_loaded`가 false인 최초 보고는 "앱 재시작 후 오늘 이미 완료된 출석"일 수 있으므로
    // 이벤트 발사 대상에서 제외해야 한다 (중복 카운트 방지).
    let was_loaded = s.data_loaded;

    let phase_update = attendance::apply_attendance_report(&mut s, &status, now);
    let tray_snapshot = match phase_update {
        Some(update) => Some(attendance::build_tray_snapshot(&s, update.remaining)),
        None if status.api_error => Some(attendance::build_tray_snapshot(&s, None)),
        None => None,
    };
    let remote_snapshot = remote_sync::attendance_snapshot_from_checker(&s, &status, now);
    let lms_session_state = remote_sync::lms_session_state(&s);
    let verification_url = (!status.needs_login)
        .then(|| s.checker.last_loaded_url.clone())
        .flatten();
    drop(s);

    if lms_session_state != previous_lms_session_state {
        if let Err(error) = app.emit_to("dashboard", LMS_SESSION_STATE_UPDATED_EVENT, lms_session_state) {
            log::warn!("[checker] LMS session state event failed: {error}");
        }
    }

    if let Some(snapshot) = tray_snapshot {
        if let Err(error) = tray::update_tray(&app, &snapshot) {
            log::error!("[tray] checker report projection update failed: {error}");
        }
    }

    if !was_loaded {
        let app_for_task = app.clone();
        if let Err(e) = app.run_on_main_thread(move || tray::sync_foreground_app_visibility(&app_for_task)) {
            log::warn!("[checker] foreground visibility sync scheduling failed: {}", e);
        }
    }

    // LMS credential은 checker WebView profile 밖으로 꺼내지 않는다. 검증된
    // checker 보고에서 정규화한 snapshot만 데스크톱 installation 세션으로 올린다.
    if let Some(last_loaded_url) = verification_url {
        remote_sync::sync_checker_report(
            window,
            last_loaded_url,
            remote_sync_service.inner().clone(),
            remote_snapshot,
        );
    } else if let Some(snapshot) = remote_snapshot {
        let remote_sync_service = remote_sync_service.inner().clone();
        tauri::async_runtime::spawn(async move {
            if let Err(error) = remote_sync_service.upload_attendance(&snapshot).await {
                log::debug!("[connected-service] attendance snapshot deferred: {error}");
            }
        });
    }

    Ok(())
}

/// Tauri 커맨드: checker.js initialization script가 로드됐음을 수신.
async fn handle_checker_ready(state: tauri::State<'_, Arc<Mutex<AppState>>>, generation: u64) -> Result<(), String> {
    let mut s = state.lock().await;
    if generation == 0 || generation != s.checker.page_load_generation {
        return Err("CHECKER_GENERATION_INVALID".into());
    }
    let actions = checker::record_checker_ready(&mut s, generation);
    if actions
        .iter()
        .any(|action| matches!(action, checker::CheckerAction::IgnoreStale { .. }))
    {
        log::warn!(
            "[checker] stale checker.js ready ignored: generation={} current_generation={}",
            generation,
            s.checker.page_load_generation,
        );
        return Ok(());
    }
    log::info!("[checker] checker.js ready: generation={}", generation);
    s.notify_scheduler();
    Ok(())
}

/// Tauri 커맨드: JS에서 Rust 로그 시스템으로 메시지 전달.
fn handle_checker_log(level: String, message: String) -> Result<(), String> {
    validate_js_log_payload(&level, &message)?;
    match level.as_str() {
        "error" => log::error!("[checker:js] {}", message),
        "warn" => log::warn!("[checker:js] {}", message),
        "debug" => log::debug!("[checker:js] {}", message),
        "info" => log::info!("[checker:js] {}", message),
        _ => unreachable!("log level was validated"),
    }
    Ok(())
}

fn validate_js_log_payload(level: &str, message: &str) -> Result<(), String> {
    if !matches!(level, "error" | "warn" | "debug" | "info")
        || message.is_empty()
        || message.len() > 2_048
        || message.chars().any(char::is_control)
    {
        return Err("LOG_PAYLOAD_INVALID".into());
    }
    Ok(())
}

// ── 설정 매크로 ──────────────────────────────────────────

async fn handle_cohort_selection(
    settings: tauri::State<'_, Arc<DesktopSettingsService>>,
    cohort_options: Vec<attendance::CohortOption>,
) -> Result<attendance::CohortResolution, String> {
    attendance::validate_cohort_options(&cohort_options)?;
    let today = chrono::Utc::now().with_timezone(&state::kst()).date_naive();
    let resolution = settings.resolve_cohort_options(cohort_options, today).await;
    Ok(resolution)
}

/// hidden LMS checker가 사용할 수 있는 유일한 원격 IPC 경계.
#[tauri::command]
pub async fn report_checker_event(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
    settings: tauri::State<'_, Arc<DesktopSettingsService>>,
    remote_sync_service: tauri::State<'_, Arc<RemoteSyncService>>,
    event: CheckerEventInput,
) -> Result<CheckerEventResponse, String> {
    {
        let state = state.lock().await;
        if !remote_sync::checker_context_is_allowed(window.label(), state.checker.last_loaded_url.as_deref()) {
            return Err("COMMAND_CONTEXT_DENIED".into());
        }
    }

    match event {
        CheckerEventInput::Ready { generation } => {
            handle_checker_ready(state, generation).await?;
            Ok(CheckerEventResponse::Acknowledged)
        }
        CheckerEventInput::Log { level, message } => {
            handle_checker_log(level, message)?;
            Ok(CheckerEventResponse::Acknowledged)
        }
        CheckerEventInput::ResolveCohort { cohort_options } => {
            let selection = handle_cohort_selection(settings, cohort_options).await?;
            Ok(CheckerEventResponse::CohortSelection { selection })
        }
        CheckerEventInput::AttendanceSnapshot { status } => {
            handle_attendance_snapshot(app, window, state, remote_sync_service, status).await?;
            Ok(CheckerEventResponse::Acknowledged)
        }
    }
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesktopSettingsInput {
    auto_start: bool,
    auto_update: bool,
    usage_analytics: bool,
    debug_mode: bool,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    selected_cohort_id: Option<String>,
}

fn deserialize_required_nullable<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    Option::<String>::deserialize(deserializer)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSettings {
    auto_start: bool,
    auto_update: bool,
    usage_analytics: bool,
    debug_mode: bool,
    selected_cohort_id: Option<String>,
    effective_cohort_id: Option<String>,
    cohort_options: Vec<attendance::CohortOption>,
}

impl From<crate::desktop_settings::DesktopSettingsSnapshot> for DesktopSettings {
    fn from(value: crate::desktop_settings::DesktopSettingsSnapshot) -> Self {
        Self {
            auto_start: value.config.auto_start,
            auto_update: value.config.auto_update,
            usage_analytics: value.config.usage_analytics,
            debug_mode: value.config.debug_mode,
            selected_cohort_id: value.config.selected_cohort_id,
            effective_cohort_id: value.effective_cohort_id,
            cohort_options: value.cohort_options,
        }
    }
}

#[tauri::command]
pub async fn get_desktop_settings(
    window: tauri::WebviewWindow,
    settings: tauri::State<'_, Arc<DesktopSettingsService>>,
) -> Result<DesktopSettings, String> {
    remote_sync::ensure_dashboard_window(&window)?;
    Ok(settings.snapshot().await.into())
}

#[tauri::command]
pub async fn update_desktop_settings(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    settings: tauri::State<'_, Arc<DesktopSettingsService>>,
    input: DesktopSettingsInput,
) -> Result<DesktopSettings, String> {
    remote_sync::ensure_dashboard_window(&window)?;
    let previous = settings.settings().await;
    let next = crate::config::Config {
        auto_start: input.auto_start,
        auto_update: input.auto_update,
        usage_analytics: input.usage_analytics,
        debug_mode: input.debug_mode,
        selected_cohort_id: input.selected_cohort_id,
    };
    log::info!(
        "[settings] 데스크톱 서비스 설정 변경: auto_start={} auto_update={} analytics={} debug={}",
        next.auto_start,
        next.auto_update,
        next.usage_analytics,
        next.debug_mode,
    );
    let saved = settings.update(&app, next).await?;

    if previous.debug_mode != saved.debug_mode {
        log::set_max_level(if saved.debug_mode {
            log::LevelFilter::Debug
        } else {
            log::LevelFilter::Info
        });
    }
    if previous.usage_analytics != saved.usage_analytics {
        if saved.usage_analytics {
            analytics::set_user_enabled(true);
            analytics::track(Event::UsageAnalyticsToggled(true));
            analytics::track(Event::AppOpened);
        } else {
            analytics::track(Event::UsageAnalyticsToggled(false));
            analytics::set_user_enabled(false);
        }
    }
    for (changed, name, value) in [
        (previous.auto_start != saved.auto_start, "auto_start", saved.auto_start),
        (
            previous.auto_update != saved.auto_update,
            "auto_update",
            saved.auto_update,
        ),
        (previous.debug_mode != saved.debug_mode, "debug_mode", saved.debug_mode),
    ] {
        if changed {
            analytics::track(Event::DesktopSettingChanged {
                setting: name,
                enabled: value,
            });
        }
    }
    if !previous.auto_update && saved.auto_update {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            crate::updater::auto_install_update(app).await;
        });
    }
    if previous.selected_cohort_id != saved.selected_cohort_id {
        checker::refresh_webview(&app, "cohort selection changed");
    }
    Ok(settings.snapshot().await.into())
}

/// 대시보드가 사용자 경로를 전달하지 못하게 하고, 앱 전용 로그 디렉터리만 연다.
#[tauri::command]
pub fn open_log_folder(window: tauri::WebviewWindow, app: tauri::AppHandle) -> Result<(), String> {
    remote_sync::ensure_dashboard_window(&window)?;
    let log_dir = app.path().app_log_dir().map_err(|error| error.to_string())?;
    log::info!("[settings] 로그 폴더 열기: {}", log_dir.display());
    tauri_plugin_opener::open_path(log_dir, None::<&str>).map_err(|error| error.to_string())
}

/// 대시보드 알림함에 표시할 영속 앱 알림 목록을 반환한다.
#[tauri::command]
pub fn get_notification_inbox_snapshot(
    window: tauri::WebviewWindow,
    inbox: tauri::State<'_, Arc<NotificationInboxService>>,
) -> Result<NotificationInboxSnapshot, String> {
    ensure_notification_reader_window(&window)?;
    inbox.snapshot()
}

/// 알림을 이동 없이 읽음 처리한다. 대시보드 알림 패널의 개별 본 처리 전용이다.
#[tauri::command]
pub fn mark_notification_read(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    inbox: tauri::State<'_, Arc<NotificationInboxService>>,
    id: String,
) -> Result<NotificationInboxSnapshot, String> {
    ensure_notification_reader_window(&window)?;
    inbox.mark_read_without_activation(&app, &id)
}

fn ensure_notification_reader_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    remote_sync::ensure_dashboard_window(window)
}

/// 앱 또는 OS 알림에서 선택한 항목을 읽음 처리하고 연결된 화면을 연다.
#[tauri::command]
pub fn activate_notification(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    inbox: tauri::State<'_, Arc<NotificationInboxService>>,
    id: String,
) -> Result<NotificationInboxSnapshot, String> {
    ensure_notification_reader_window(&window)?;
    inbox.activate(&app, &id)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestNotificationResult {
    snapshot: NotificationInboxSnapshot,
    system_delivered: bool,
    mobile_queued: Option<usize>,
}

/// 대시보드에서 운영체제 알림과 앱 알림함을 함께 검증하는 사용자 요청 테스트 알림이다.
#[tauri::command]
pub async fn send_test_notification(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    notifications: tauri::State<'_, Arc<NotificationService>>,
    inbox: tauri::State<'_, Arc<NotificationInboxService>>,
    remote_sync: tauri::State<'_, Arc<RemoteSyncService>>,
) -> Result<TestNotificationResult, String> {
    remote_sync::ensure_dashboard_window(&window)?;
    let key = format!("manual-test:{}", chrono::Utc::now().timestamp_millis());
    let report = notifications.deliver(
        &app,
        NotificationRequest {
            key: &key,
            title: "Jungle Bell 테스트 알림",
            body: "알림이 정상적으로 연결되었습니다.",
            action: None,
            repeat_after_ms: None,
        },
    );
    let mobile_queued = match remote_sync.broadcast_test_notification(report.inbox_recorded).await {
        Ok(queued) => Some(queued),
        Err(error) => {
            log::warn!("[test-notification] mobile broadcast failed: {error}");
            None
        }
    };
    Ok(TestNotificationResult {
        snapshot: inbox.snapshot()?,
        system_delivered: report.system_delivered,
        mobile_queued,
    })
}

#[cfg(test)]
mod tests {
    use super::{validate_js_log_payload, CheckerEventInput, CheckerEventResponse, DesktopSettingsInput};

    #[test]
    fn 원격_js_로그_payload는_레벨_크기_제어문자를_검증한다() {
        assert!(validate_js_log_payload("info", "checker ready").is_ok());
        assert!(validate_js_log_payload("trace", "checker ready").is_err());
        assert!(validate_js_log_payload("warn", "").is_err());
        assert!(validate_js_log_payload("warn", "line\nbreak").is_err());
        assert!(validate_js_log_payload("warn", &"x".repeat(2_049)).is_err());
    }

    #[test]
    fn checker_event는_단일_camel_case_tagged_계약만_받는다() {
        let valid = serde_json::json!({
            "type": "resolveCohort",
            "cohortOptions": [{
                "id": "cohort-1",
                "label": "1기",
                "startDate": "2026-08-01",
                "endDate": "2026-08-31",
                "isActive": true
            }]
        });
        assert!(matches!(
            serde_json::from_value::<CheckerEventInput>(valid),
            Ok(CheckerEventInput::ResolveCohort { .. })
        ));
        for invalid in [
            serde_json::json!({"type": "resolveCohort", "cohort_options": []}),
            serde_json::json!({"type": "resolveCohort", "cohortOptions": [], "legacy": true}),
            serde_json::json!({"type": "reportAttendance", "status": {}}),
        ] {
            assert!(serde_json::from_value::<CheckerEventInput>(invalid).is_err());
        }

        assert_eq!(
            serde_json::to_value(CheckerEventResponse::Acknowledged).unwrap(),
            serde_json::json!({"type": "acknowledged"})
        );
    }

    #[test]
    fn 데스크톱_설정은_nullable_기수_선택을_필수로_받는다() {
        let current = serde_json::json!({
            "autoStart": false,
            "autoUpdate": true,
            "usageAnalytics": true,
            "debugMode": false,
            "selectedCohortId": null
        });
        assert!(serde_json::from_value::<DesktopSettingsInput>(current).is_ok());
        for invalid in [
            serde_json::json!({
                "autoStart": false,
                "autoUpdate": true,
                "usageAnalytics": true,
                "debugMode": false
            }),
            serde_json::json!({
                "autoStart": false,
                "autoUpdate": true,
                "usageAnalytics": true,
                "debugMode": false,
                "selectedCohortId": null,
                "legacy": true
            }),
        ] {
            assert!(serde_json::from_value::<DesktopSettingsInput>(invalid).is_err());
        }
    }

    #[test]
    fn checker_attendance_snapshot은_현재_필드가_모두_필수다() {
        let current = serde_json::json!({
            "type": "attendanceSnapshot",
            "status": {
                "generation": 1,
                "needs_login": false,
                "morning_done": true,
                "evening_done": false,
                "api_error": false,
                "cohort_status": "active",
                "cohort_start_date": "2026-08-01",
                "cohort_end_date": "2026-08-31"
            }
        });
        assert!(serde_json::from_value::<CheckerEventInput>(current.clone()).is_ok());
        let mut nullable_dates = current.clone();
        nullable_dates["status"]["cohort_start_date"] = serde_json::Value::Null;
        nullable_dates["status"]["cohort_end_date"] = serde_json::Value::Null;
        assert!(serde_json::from_value::<CheckerEventInput>(nullable_dates).is_ok());

        for field in [
            "morning_done",
            "evening_done",
            "api_error",
            "cohort_status",
            "cohort_start_date",
            "cohort_end_date",
        ] {
            let mut missing = current.clone();
            missing
                .get_mut("status")
                .and_then(serde_json::Value::as_object_mut)
                .unwrap()
                .remove(field);
            assert!(
                serde_json::from_value::<CheckerEventInput>(missing).is_err(),
                "missing {field} must be rejected"
            );
        }
    }
}
