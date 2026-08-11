//! 커맨드 모듈 — 모든 Tauri invoke 핸들러.
//!
//! JS에서 `window.__TAURI__.core.invoke()`로 호출하는
//! 모든 커맨드 함수가 이 모듈에 정의된다.
//! 도메인 로직은 `checker`, `updater` 등 전용 모듈에 위임한다.

use std::sync::Arc;

use serde::Serialize;
use tokio::sync::Mutex;

use crate::attendance;
use crate::campus::{CampusDataKind, CampusService};
use crate::checker;
use crate::desktop_settings::DesktopSettingsService;
use crate::notification_inbox::{NotificationInboxService, NotificationInboxSnapshot};
use crate::notification_service::{NotificationRequest, NotificationService};
use crate::remote_sync::{self, RemoteSyncService};
use crate::state::{self, AppState};
use crate::tray;

// ── 연결 서비스 대시보드 경계 ───────────────────────────

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
pub(crate) async fn create_mobile_pairing(
    window: tauri::WebviewWindow,
    service: tauri::State<'_, Arc<RemoteSyncService>>,
) -> Result<remote_sync::MobilePairing, String> {
    remote_sync::create_mobile_pairing(window, service).await
}

#[tauri::command]
pub(crate) async fn get_mobile_pairing_status(
    window: tauri::WebviewWindow,
    service: tauri::State<'_, Arc<RemoteSyncService>>,
    pairing_id: String,
) -> Result<remote_sync::MobilePairingStatus, String> {
    remote_sync::get_mobile_pairing_status(window, service, pairing_id).await
}

#[tauri::command]
pub(crate) async fn approve_mobile_pairing(
    window: tauri::WebviewWindow,
    service: tauri::State<'_, Arc<RemoteSyncService>>,
    pairing_id: String,
    claim_id: String,
) -> Result<(), String> {
    remote_sync::approve_mobile_pairing(window, service, pairing_id, claim_id).await
}

#[tauri::command]
pub(crate) async fn list_mobile_sessions(
    window: tauri::WebviewWindow,
    service: tauri::State<'_, Arc<RemoteSyncService>>,
) -> Result<Vec<remote_sync::MobileDevice>, String> {
    remote_sync::list_mobile_sessions(window, service).await
}

#[tauri::command]
pub(crate) async fn revoke_mobile_session(
    window: tauri::WebviewWindow,
    service: tauri::State<'_, Arc<RemoteSyncService>>,
    device_id: String,
) -> Result<(), String> {
    remote_sync::revoke_mobile_session(window, service, device_id).await
}

#[tauri::command]
pub(crate) async fn get_remote_attendance_snapshot(
    window: tauri::WebviewWindow,
    service: tauri::State<'_, Arc<RemoteSyncService>>,
) -> Result<remote_sync::RemoteAttendanceEnvelope, String> {
    remote_sync::get_remote_attendance_snapshot(window, service).await
}

#[tauri::command]
pub(crate) async fn get_attendance_preferences(
    window: tauri::WebviewWindow,
    service: tauri::State<'_, Arc<RemoteSyncService>>,
) -> Result<remote_sync::AttendancePreferences, String> {
    remote_sync::get_attendance_preferences(window, service).await
}

#[tauri::command]
pub(crate) async fn update_attendance_preferences(
    window: tauri::WebviewWindow,
    service: tauri::State<'_, Arc<RemoteSyncService>>,
    input: remote_sync::AttendancePreferences,
) -> Result<remote_sync::AttendancePreferences, String> {
    remote_sync::update_attendance_preferences(window, service, input).await
}

#[tauri::command]
pub(crate) async fn get_meal_preferences(
    window: tauri::WebviewWindow,
    service: tauri::State<'_, Arc<RemoteSyncService>>,
) -> Result<remote_sync::MealPreferences, String> {
    remote_sync::get_meal_preferences(window, service).await
}

#[tauri::command]
pub(crate) async fn update_meal_preferences(
    window: tauri::WebviewWindow,
    service: tauri::State<'_, Arc<RemoteSyncService>>,
    input: remote_sync::MealPreferencesInput,
) -> Result<remote_sync::MealPreferences, String> {
    remote_sync::update_meal_preferences(window, service, input).await
}

#[tauri::command]
pub(crate) async fn list_laundry_watches(
    window: tauri::WebviewWindow,
    service: tauri::State<'_, Arc<RemoteSyncService>>,
) -> Result<remote_sync::LaundryWatchEnvelope, String> {
    remote_sync::list_laundry_watches(window, service).await
}

#[tauri::command]
pub(crate) async fn create_laundry_watch(
    window: tauri::WebviewWindow,
    service: tauri::State<'_, Arc<RemoteSyncService>>,
    input: remote_sync::LaundryWatchInput,
) -> Result<remote_sync::RemoteLaundryWatch, String> {
    remote_sync::create_laundry_watch(window, service, input).await
}

#[tauri::command]
pub(crate) async fn delete_laundry_watch(
    window: tauri::WebviewWindow,
    service: tauri::State<'_, Arc<RemoteSyncService>>,
    watch_id: String,
) -> Result<(), String> {
    remote_sync::delete_laundry_watch(window, service, watch_id).await
}

#[tauri::command]
pub(crate) async fn list_laundry_queue(
    window: tauri::WebviewWindow,
    service: tauri::State<'_, Arc<RemoteSyncService>>,
) -> Result<remote_sync::LaundryQueueEnvelope, String> {
    remote_sync::list_laundry_queue(window, service).await
}

#[tauri::command]
pub(crate) async fn join_laundry_queue(
    window: tauri::WebviewWindow,
    service: tauri::State<'_, Arc<RemoteSyncService>>,
    input: remote_sync::LaundryQueueInput,
) -> Result<remote_sync::LaundryQueueEntry, String> {
    remote_sync::join_laundry_queue(window, service, input).await
}

#[tauri::command]
pub(crate) async fn leave_laundry_queue(
    window: tauri::WebviewWindow,
    service: tauri::State<'_, Arc<RemoteSyncService>>,
    entry_id: String,
) -> Result<(), String> {
    remote_sync::leave_laundry_queue(window, service, entry_id).await
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
    let verification_url = (!status.needs_login)
        .then(|| s.checker.last_loaded_url.clone())
        .flatten();
    drop(s);

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

/// 생활정보 창이 이벤트 구독을 마쳤음을 보고한다.
#[tauri::command]
pub async fn report_campus_ready(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    service: tauri::State<'_, Arc<CampusService>>,
) -> Result<(), String> {
    remote_sync::ensure_dashboard_window(&window)?;
    log::info!("[dashboard] frontend ready");
    service.emit_cached_snapshots(&app).await;
    Ok(())
}

/// 사용자가 누른 수동 새로고침을 즉시 실행한다.
#[tauri::command]
pub async fn refresh_campus_data(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    service: tauri::State<'_, Arc<CampusService>>,
    kind: CampusDataKind,
) -> Result<(), String> {
    remote_sync::ensure_dashboard_window(&window)?;
    service.refresh(&app, kind).await
}

/// 로컬 대시보드 전용 공개 생활정보 경계.
/// WebView가 API origin에 직접 연결하거나 인증 헤더를 다루지 않게 한다.
#[tauri::command]
pub async fn get_dashboard_campus_data(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    service: tauri::State<'_, Arc<CampusService>>,
    kind: CampusDataKind,
) -> Result<serde_json::Value, String> {
    remote_sync::ensure_dashboard_window(&window)?;
    service.dashboard_data(&app, kind).await
}

/// 로컬 대시보드 전용 과거 급식 페이지 경계.
#[tauri::command]
pub async fn get_dashboard_meal_history(
    window: tauri::WebviewWindow,
    service: tauri::State<'_, Arc<CampusService>>,
    before: Option<String>,
    limit: u8,
) -> Result<serde_json::Value, String> {
    remote_sync::ensure_dashboard_window(&window)?;
    service.meal_history(before.as_deref(), limit).await
}

#[derive(Debug, Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesktopSettingsInput {
    auto_start: bool,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSettings {
    auto_start: bool,
}

#[tauri::command]
pub async fn get_desktop_settings(
    window: tauri::WebviewWindow,
    settings: tauri::State<'_, Arc<DesktopSettingsService>>,
) -> Result<DesktopSettings, String> {
    remote_sync::ensure_dashboard_window(&window)?;
    Ok(DesktopSettings {
        auto_start: settings.auto_start().await,
    })
}

#[tauri::command]
pub async fn update_desktop_settings(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    settings: tauri::State<'_, Arc<DesktopSettingsService>>,
    input: DesktopSettingsInput,
) -> Result<DesktopSettings, String> {
    remote_sync::ensure_dashboard_window(&window)?;
    log::info!("[settings] 자동 시작 설정 변경: {}", input.auto_start);
    let auto_start = settings.update_auto_start(&app, input.auto_start).await?;
    Ok(DesktopSettings { auto_start })
}

/// 대시보드 홈에 표시할 로컬 출석·알림·캠퍼스 캐시를 반환한다.
#[tauri::command]
pub async fn get_dashboard_home_overview(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
    campus: tauri::State<'_, Arc<CampusService>>,
    inbox: tauri::State<'_, Arc<NotificationInboxService>>,
) -> Result<tray::DashboardHomeOverview, String> {
    remote_sync::ensure_dashboard_window(&window)?;

    let attendance = tray::get_dashboard_attendance_summary(&app)?;
    let lms_session_state = {
        let state = state.lock().await;
        remote_sync::lms_session_state(&state)
    };
    let unread_count = inbox.snapshot()?.unread_count;
    let (laundry, meals) = tokio::join!(
        campus.cached_dashboard_data(CampusDataKind::Laundry),
        campus.cached_dashboard_data(CampusDataKind::Meals),
    );

    Ok(tray::DashboardHomeOverview {
        attendance,
        lms_session_state,
        unread_count,
        laundry,
        meals,
    })
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
    use super::{validate_js_log_payload, CheckerEventInput, CheckerEventResponse};

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
}
