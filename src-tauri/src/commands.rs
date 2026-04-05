//! 커맨드 모듈 — 모든 Tauri invoke 핸들러.
//!
//! JS에서 `window.__TAURI__.core.invoke()`로 호출하는
//! 모든 커맨드 함수가 이 모듈에 정의된다.
//! 도메인 로직은 `checker`, `updater` 등 전용 모듈에 위임한다.

use std::process::Command;
use std::sync::Arc;

use chrono::Timelike;
use tauri::Manager;
use tokio::sync::Mutex;

use tauri_plugin_autostart::ManagerExt as AutostartManagerExt;

use crate::checker;
use crate::config::TimeOfDay;
use crate::state::{self, AppState};
use crate::tray;

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
            status.needs_login, status.morning_done, status.evening_done, s.phase,
        );
        drop(s);
    }

    let mut s = state.lock().await;
    let now = chrono::Utc::now();
    if let Some((phase, remaining)) = checker::process_report(&mut s, &status, now) {
        tray::update_tray(&app, phase, remaining, s.needs_login);
    }

    Ok(())
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

/// u32 설정 getter/setter 생성 매크로.
macro_rules! setting_u32 {
    ($get:ident, $set:ident, $field:ident, $label:expr) => {
        #[tauri::command]
        pub async fn $get(state: tauri::State<'_, Arc<Mutex<AppState>>>) -> Result<u32, String> {
            Ok(state.lock().await.config.$field)
        }

        #[tauri::command]
        pub async fn $set(state: tauri::State<'_, Arc<Mutex<AppState>>>, value: u32) -> Result<(), String> {
            log::info!("[settings] {} 변경: {}", $label, value);
            let mut s = state.lock().await;
            s.config.$field = value;
            s.config.save();
            Ok(())
        }
    };
}

/// TimeOfDay 설정 getter/setter 생성 매크로.
macro_rules! setting_time {
    ($get:ident, $set:ident, $field:ident, $label:expr) => {
        #[tauri::command]
        pub async fn $get(state: tauri::State<'_, Arc<Mutex<AppState>>>) -> Result<TimeOfDay, String> {
            let s = state.lock().await;
            Ok(s.config.$field.clone())
        }

        #[tauri::command]
        pub async fn $set(state: tauri::State<'_, Arc<Mutex<AppState>>>, hour: u32, minute: u32) -> Result<(), String> {
            log::info!("[settings] {} 변경: {:02}:{:02}", $label, hour, minute);
            let mut s = state.lock().await;
            s.config.$field = TimeOfDay { hour, minute };
            s.config.save();
            Ok(())
        }
    };
}

// ── 매크로 생성 설정 커맨드 ──────────────────────────────

setting_bool!(get_auto_update, set_auto_update, auto_update, "자동 업데이트 설정");
setting_bool!(get_start_notification_enabled, set_start_notification_enabled, start_notification_enabled, "시작 출석 알림 설정");
setting_bool!(get_end_notification_enabled, set_end_notification_enabled, end_notification_enabled, "종료 출석 알림 설정");
setting_u32!(get_start_notification_interval, set_start_notification_interval, start_notification_interval_mins, "시작 출석 알림 간격");
setting_u32!(get_end_notification_interval, set_end_notification_interval, end_notification_interval_mins, "종료 출석 알림 간격");
setting_time!(get_notification_start, set_notification_start, notification_start, "알림 시작 시각");
setting_time!(get_notification_end, set_notification_end, notification_end, "알림 종료 시각");

setting_bool!(get_skip_sunday, set_skip_sunday, skip_sunday, "일요일 알림 끄기");

// ── 커스텀 설정 커맨드 ───────────────────────────────────

/// Tauri 커맨드: 이번 출석 알림 끄기 상태 조회.
/// config.skip_attendance가 현재 "출석일" 날짜와 일치하면 true.
/// 자정~morning_start 사이에는 전날 날짜도 유효로 판정.
#[tauri::command]
pub async fn get_skip_attendance(state: tauri::State<'_, Arc<Mutex<AppState>>>) -> Result<bool, String> {
    let s = state.lock().await;
    let kst_now = chrono::Utc::now().with_timezone(&state::kst());
    let today = kst_now.format("%Y-%m-%d").to_string();
    if s.config.skip_attendance.as_deref() == Some(today.as_str()) {
        return Ok(true);
    }
    // 자정~morning_start 사이: 전날 skip이 아직 유효
    if kst_now.hour() < s.config.morning_start.hour as u32 {
        let yesterday = (kst_now - chrono::Duration::days(1))
            .format("%Y-%m-%d")
            .to_string();
        if s.config.skip_attendance.as_deref() == Some(yesterday.as_str()) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Tauri 커맨드: 이번 출석 알림 끄기 설정 변경 및 저장.
/// enabled=true이면 오늘 KST 날짜를 저장, false이면 None.
#[tauri::command]
pub async fn set_skip_attendance(state: tauri::State<'_, Arc<Mutex<AppState>>>, enabled: bool) -> Result<(), String> {
    let mut s = state.lock().await;
    s.config.skip_attendance = if enabled {
        Some(
            chrono::Utc::now()
                .with_timezone(&state::kst())
                .format("%Y-%m-%d")
                .to_string(),
        )
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
    let autolaunch = app.autolaunch();
    let result = if enabled {
        autolaunch.enable()
    } else {
        autolaunch.disable()
    };
    result.map_err(|e| e.to_string())?;
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

// ── 업데이트 ─────────────────────────────────────────────

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
