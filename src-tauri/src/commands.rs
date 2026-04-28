//! 커맨드 모듈 — 모든 Tauri invoke 핸들러.
//!
//! JS에서 `window.__TAURI__.core.invoke()`로 호출하는
//! 모든 커맨드 함수가 이 모듈에 정의된다.
//! 도메인 로직은 `checker`, `updater` 등 전용 모듈에 위임한다.

use std::process::Command;
use std::sync::Arc;

use serde::Serialize;
use tauri::{Emitter, Manager};
use tokio::sync::Mutex;

use crate::analytics;
use crate::attendance_day;
use crate::autostart;
use crate::checker;
use crate::config::{self, TimeOfDay};
use crate::state::{self, AppState};
use crate::tray;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginStatus {
    pub data_loaded: bool,
    pub needs_login: bool,
}

impl LoginStatus {
    fn from_state(state: &AppState) -> Self {
        Self {
            data_loaded: state.data_loaded,
            needs_login: state.needs_login,
        }
    }
}

// ── 출석 보고 ────────────────────────────────────────────

/// Tauri 커맨드: API 조회 결과를 수신.
/// `trigger_check()`가 이벤트를 보내면, JS가 이 커맨드를 invoke로 호출한다.
#[tauri::command]
pub async fn report_attendance_status(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
    status: checker::AttendanceReport,
) -> Result<(), String> {
    if status.api_error {
        log::info!("[checker] API error received, skipping state update");
    } else {
        let s = state.lock().await;
        log::info!(
            "[checker] report: needs_login={} morning={} evening={} current_phase={:?}",
            status.needs_login,
            status.morning_done,
            status.evening_done,
            s.phase,
        );
        drop(s);
    }

    let mut s = state.lock().await;
    let now = chrono::Utc::now();

    // 전이 감지를 위해 이전 상태 보존.
    // `was_loaded`가 false인 최초 보고는 "앱 재시작 후 오늘 이미 완료된 출석"일 수 있으므로
    // 이벤트 발사 대상에서 제외해야 한다 (중복 카운트 방지).
    let was_loaded = s.data_loaded;
    let prev_data_loaded = s.data_loaded;
    let prev_morning = s.morning_checked;
    let prev_evening = s.evening_checked;
    let prev_needs_login = s.needs_login;

    if let Some((phase, remaining)) = checker::process_report(&mut s, &status, now) {
        tray::update_tray(&app, phase, remaining, s.needs_login);
    }
    let curr_needs_login = s.needs_login;
    let curr_data_loaded = s.data_loaded;
    let login_status = LoginStatus::from_state(&s);
    drop(s);

    // 로그인 상태/초기 로드 상태 전이 시 이벤트 발사 — 온보딩 슬라이드가 ✓ 표시 갱신용으로 listen.
    if prev_needs_login != curr_needs_login || prev_data_loaded != curr_data_loaded {
        let _ = app.emit("login-status-changed", login_status);
    }

    // 출석 완료 이벤트: false → true 전이 시점에만 한 번 발사한다.
    // 스케줄러의 일일 리셋(자정) 이후 첫 완료 시에도 정상적으로 전이로 감지된다.
    if was_loaded && !status.api_error && !status.needs_login {
        if !prev_morning && status.morning_done {
            analytics::track_attendance_completed("morning");
        }
        if !prev_evening && status.evening_done {
            analytics::track_attendance_completed("evening");
        }
    }

    Ok(())
}

/// Tauri 커맨드: CMS 사용자 식별자 수신. JS에서 /api/v2/me 호출 후 id를 전달.
/// SHA-256 해시하여 PostHog distinct_id로 사용.
#[tauri::command]
pub fn report_cms_identity(cms_user_id: String) {
    analytics::set_identity(&cms_user_id);
}

/// Tauri 커맨드: JS에서 Rust 로그 시스템으로 메시지 전달.
#[tauri::command]
pub fn log_from_js(level: String, message: String) {
    match level.as_str() {
        "error" => log::error!("[checker:js] {}", message),
        "warn" => log::warn!("[checker:js] {}", message),
        "debug" => log::debug!("[checker:js] {}", message),
        _ => log::info!("[checker:js] {}", message),
    }
}

// ── 설정 매크로 ──────────────────────────────────────────

/// bool 설정 getter/setter 생성 매크로.
macro_rules! setting_bool {
    ($get:ident, $set:ident, $field:ident, $label:expr) => {
        #[tauri::command]
        pub async fn $get(state: tauri::State<'_, Arc<Mutex<AppState>>>) -> Result<bool, String> {
            Ok(state.lock().await.config.$field)
        }

        #[tauri::command]
        pub async fn $set(state: tauri::State<'_, Arc<Mutex<AppState>>>, enabled: bool) -> Result<(), String> {
            log::info!("[settings] {} 변경: {}", $label, enabled);
            let mut s = state.lock().await;
            s.config.$field = enabled;
            s.config.save();
            Ok(())
        }
    };
}

// ── 매크로 생성 설정 커맨드 ──────────────────────────────

setting_bool!(get_auto_update, set_auto_update, auto_update, "자동 업데이트 설정");
setting_bool!(
    get_start_notification_enabled,
    set_start_notification_enabled,
    start_notification_enabled,
    "시작 출석 알림 설정"
);
setting_bool!(
    get_end_notification_enabled,
    set_end_notification_enabled,
    end_notification_enabled,
    "종료 출석 알림 설정"
);

setting_bool!(get_skip_sunday, set_skip_sunday, skip_sunday, "일요일 알림 끄기");

// ── 커스텀 설정 커맨드 ───────────────────────────────────

#[tauri::command]
pub async fn get_start_notification_interval(state: tauri::State<'_, Arc<Mutex<AppState>>>) -> Result<u32, String> {
    Ok(state.lock().await.config.start_notification_interval_mins)
}

#[tauri::command]
pub async fn set_start_notification_interval(
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
    value: u32,
) -> Result<(), String> {
    let value = config::validate_notification_interval(value)?;
    log::info!("[settings] 시작 출석 알림 간격 변경: {}", value);
    let mut s = state.lock().await;
    s.config.start_notification_interval_mins = value;
    s.config.save();
    Ok(())
}

#[tauri::command]
pub async fn get_end_notification_interval(state: tauri::State<'_, Arc<Mutex<AppState>>>) -> Result<u32, String> {
    Ok(state.lock().await.config.end_notification_interval_mins)
}

#[tauri::command]
pub async fn set_end_notification_interval(
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
    value: u32,
) -> Result<(), String> {
    let value = config::validate_notification_interval(value)?;
    log::info!("[settings] 종료 출석 알림 간격 변경: {}", value);
    let mut s = state.lock().await;
    s.config.end_notification_interval_mins = value;
    s.config.save();
    Ok(())
}

#[tauri::command]
pub async fn get_notification_start(state: tauri::State<'_, Arc<Mutex<AppState>>>) -> Result<TimeOfDay, String> {
    Ok(state.lock().await.config.notification_start.clone())
}

#[tauri::command]
pub async fn set_notification_start(
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
    hour: u32,
    minute: u32,
) -> Result<(), String> {
    let time = config::validate_notification_start(hour, minute)?;
    log::info!("[settings] 알림 시작 시각 변경: {:02}:{:02}", time.hour, time.minute);
    let mut s = state.lock().await;
    s.config.notification_start = time;
    s.config.save();
    Ok(())
}

#[tauri::command]
pub async fn get_notification_end(state: tauri::State<'_, Arc<Mutex<AppState>>>) -> Result<TimeOfDay, String> {
    Ok(state.lock().await.config.notification_end.clone())
}

#[tauri::command]
pub async fn set_notification_end(
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
    hour: u32,
    minute: u32,
) -> Result<(), String> {
    let time = config::validate_notification_end(hour, minute)?;
    log::info!("[settings] 알림 종료 시각 변경: {:02}:{:02}", time.hour, time.minute);
    let mut s = state.lock().await;
    s.config.notification_end = time;
    s.config.save();
    Ok(())
}

/// Tauri 커맨드: 이번 출석 알림 끄기 상태 조회.
/// config.skip_attendance가 현재 "출석일" 날짜와 일치하면 true.
/// 자정~morning_start 사이에는 전날 날짜도 유효로 판정.
#[tauri::command]
pub async fn get_skip_attendance(state: tauri::State<'_, Arc<Mutex<AppState>>>) -> Result<bool, String> {
    let s = state.lock().await;
    let kst_now = chrono::Utc::now().with_timezone(&state::kst());

    Ok(attendance_day::is_skip_attendance_active(&s.config, kst_now))
}

/// Tauri 커맨드: 이번 출석 알림 끄기 설정 변경 및 저장.
/// enabled=true이면 오늘 KST 날짜를 저장, false이면 None.
#[tauri::command]
pub async fn set_skip_attendance(state: tauri::State<'_, Arc<Mutex<AppState>>>, enabled: bool) -> Result<(), String> {
    let mut s = state.lock().await;
    s.config.skip_attendance = if enabled {
        let kst_now = chrono::Utc::now().with_timezone(&state::kst());
        Some(attendance_day::calendar_date_string(kst_now))
    } else {
        None
    };
    log::info!("[settings] 이번 출석 알림 끄기 변경: {:?}", s.config.skip_attendance);
    s.config.save();
    Ok(())
}

/// Tauri 커맨드: 현재 앱 버전 반환.
#[tauri::command]
pub fn get_app_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

/// Tauri 커맨드: 자동 시작 설정 조회.
#[tauri::command]
pub async fn get_auto_start(state: tauri::State<'_, Arc<Mutex<AppState>>>) -> Result<bool, String> {
    Ok(state.lock().await.config.auto_start)
}

/// Tauri 커맨드: 자동 시작 설정 변경 및 저장.
#[tauri::command]
pub async fn set_auto_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
    enabled: bool,
) -> Result<(), String> {
    log::info!("[settings] 자동 시작 설정 변경: {}", enabled);
    // 앱 설정을 먼저 저장한 후 OS 설정을 변경한다.
    // OS 변경에 실패하더라도 다음 실행 시 setup에서 Config 기준으로 재동기화된다.
    {
        let mut s = state.lock().await;
        s.config.auto_start = enabled;
        s.config.save();
    }
    autostart::sync_auto_start(&app, enabled)?;
    Ok(())
}

/// Tauri 커맨드: 디버그 모드 설정 조회.
#[tauri::command]
pub async fn get_debug_mode(state: tauri::State<'_, Arc<Mutex<AppState>>>) -> Result<bool, String> {
    Ok(state.lock().await.config.debug_mode)
}

/// Tauri 커맨드: 디버그 모드 설정 변경 및 저장.
/// 런타임에 로그 레벨도 즉시 전환 (Info ↔ Debug).
#[tauri::command]
pub async fn set_debug_mode(state: tauri::State<'_, Arc<Mutex<AppState>>>, enabled: bool) -> Result<(), String> {
    log::info!("[settings] 디버그 모드 변경: {}", enabled);
    let mut s = state.lock().await;
    s.config.debug_mode = enabled;
    s.config.save();

    // 런타임 로그 레벨 즉시 전환
    let level = if enabled {
        log::LevelFilter::Debug
    } else {
        log::LevelFilter::Info
    };
    log::set_max_level(level);
    log::info!("[settings] 로그 레벨 전환: {}", level);
    Ok(())
}

/// Tauri 커맨드: 사용 통계 전송 설정 조회.
#[tauri::command]
pub async fn get_usage_analytics_enabled(state: tauri::State<'_, Arc<Mutex<AppState>>>) -> Result<bool, String> {
    Ok(state.lock().await.config.usage_analytics_enabled)
}

/// Tauri 커맨드: 사용 통계 전송 설정 변경 및 저장.
#[tauri::command]
pub async fn set_usage_analytics_enabled(
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
    enabled: bool,
) -> Result<(), String> {
    log::info!("[settings] 사용 통계 전송 변경: {}", enabled);
    let mut s = state.lock().await;
    s.config.usage_analytics_enabled = enabled;
    s.config.save();
    analytics::set_user_enabled(enabled);
    Ok(())
}

// ── 업데이트 ─────────────────────────────────────────────

/// Tauri 커맨드: 주기적 체크에서 발견된 업데이트 버전 반환. None이면 최신 버전.
#[tauri::command]
pub async fn get_pending_update(state: tauri::State<'_, Arc<Mutex<AppState>>>) -> Result<Option<String>, String> {
    Ok(state.lock().await.pending_update.clone())
}

/// Tauri 커맨드: 업데이트 확인 후 결과를 시스템 다이얼로그로 표시.
#[tauri::command]
pub async fn check_and_notify_update(app: tauri::AppHandle) -> Result<(), String> {
    log::info!("[updater] 업데이트 확인 요청");
    tauri::async_runtime::spawn(async move {
        crate::updater::prompt_and_install_update(app, false).await;
    });
    Ok(())
}

// ── 시스템 유틸 ──────────────────────────────────────────

/// Tauri 커맨드: 로그 폴더를 시스템 파일 탐색기로 열기.
#[tauri::command]
pub async fn open_log_folder(app: tauri::AppHandle) -> Result<(), String> {
    let log_dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    log::info!("[settings] 로그 폴더 열기: {:?}", log_dir);
    tauri_plugin_opener::open_path(&log_dir, None::<&str>).map_err(|e| e.to_string())
}

/// Tauri 커맨드: 온보딩(시작하기) 창을 연다.
#[tauri::command]
pub fn open_onboarding(app: tauri::AppHandle) {
    tray::open_onboarding_window(&app);
}

/// Tauri 커맨드: 온보딩(시작하기) 창을 닫는다.
#[tauri::command]
pub fn close_onboarding(app: tauri::AppHandle) {
    tray::close_onboarding_window(&app);
}

/// Tauri 커맨드: 온보딩 완료를 저장한 뒤 창을 닫는다.
#[tauri::command]
pub async fn complete_onboarding(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
) -> Result<(), String> {
    {
        let mut state = state.lock().await;
        state.config.onboarding_completed = true;
        state.config.save();
    }
    tray::close_onboarding_window(&app);
    Ok(())
}

/// Tauri 커맨드: 출석 페이지 창을 연다 (온보딩의 "출석 페이지 열기" 버튼용).
/// 트레이 메뉴의 "출석 페이지 열기"와 동일한 동작.
#[tauri::command]
pub fn open_attendance_window(app: tauri::AppHandle) {
    tray::open_attendance_window(&app);
    tray::refresh_login_status(&app);
}

/// Tauri 커맨드: 현재 로그인 확인 상태 조회.
/// 온보딩 슬라이드 진입 시 초기 표시 여부 결정용.
#[tauri::command]
pub async fn get_login_status(state: tauri::State<'_, Arc<Mutex<AppState>>>) -> Result<LoginStatus, String> {
    let state = state.lock().await;
    Ok(LoginStatus::from_state(&state))
}

/// Tauri 커맨드: hidden checker를 다시 출석 페이지로 이동시켜 로그인 상태를 재확인한다.
/// 온보딩에서 출석 창 로그인 완료를 빠르게 감지하기 위한 보조 커맨드.
#[tauri::command]
pub fn refresh_login_status(app: tauri::AppHandle) {
    tray::refresh_login_status(&app);
}

/// Tauri 커맨드: OS 알림 설정 화면을 연다.
#[tauri::command]
pub async fn open_notification_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let targets = [
            "x-apple.systempreferences:com.apple.Notifications-Settings.extension",
            "x-apple.systempreferences:com.apple.preference.notifications",
        ];

        for target in targets {
            let status = Command::new("open")
                .arg(target)
                .status()
                .map_err(|e| format!("macOS 설정 앱 실행 실패: {}", e))?;
            if status.success() {
                log::info!("[settings] macOS 알림 설정 열기: {}", target);
                return Ok(());
            }
        }

        return Err("macOS 알림 설정을 열지 못했습니다.".into());
    }

    #[cfg(target_os = "windows")]
    {
        let status = Command::new("cmd")
            .args(["/C", "start", "", "ms-settings:notifications"])
            .status()
            .map_err(|e| format!("Windows 설정 앱 실행 실패: {}", e))?;
        if status.success() {
            log::info!("[settings] Windows 알림 설정 열기");
            return Ok(());
        }

        return Err("Windows 알림 설정을 열지 못했습니다.".into());
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Err("이 플랫폼에서는 시스템 알림 설정 바로가기를 지원하지 않습니다.".into())
    }
}
