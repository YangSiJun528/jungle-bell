//! 체커 모듈 — API 기반 출석 상태 수신·처리.
//!
//! checker.js가 WebView에 주입되어 LMS REST API를 호출한다.
//! Rust가 `trigger_check()`로 이벤트를 발송하면,
//! JS가 API를 조회해 `report_attendance_status` invoke로 반환한다.
//! 이 모듈은 반환된 결과를 처리하고 공유 앱 상태를 갱신한다.

use std::process::Command;
use std::sync::Arc;

use log::{debug, info};
use serde::Deserialize;
use tauri::{Emitter, Manager};
use tokio::sync::Mutex;

use tauri_plugin_autostart::ManagerExt as AutostartManagerExt;
use tauri_plugin_updater::UpdaterExt;

use chrono::{DateTime, Utc};

use crate::config::TimeOfDay;
use crate::state::{self, AppState, DailyPhase};
use crate::tray;

/// checker.js의 API 조회 결과.
/// JS invoke 호출의 JSON 페이로드에서 역직렬화됨.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct AttendanceReport {
    /// 로그인이 필요한 상태 (401 또는 로그인 페이지)
    pub needs_login: bool,
    /// 출석(체크인) 완료 여부
    #[serde(default)]
    pub morning_done: bool,
    /// 퇴실(체크아웃) 완료 여부
    #[serde(default)]
    pub evening_done: bool,
    /// API 호출 실패 여부 (true이면 상태 갱신 건너뜀)
    #[serde(default)]
    pub api_error: bool,
}

/// 체커 보고를 공유 앱 상태에 반영.
pub fn apply_report(state: &mut AppState, report: &AttendanceReport) {
    state.data_loaded = true;

    if report.needs_login {
        state.needs_login = true;
        return;
    }

    state.needs_login = false;
    state.login_retry_until = None; // 로그인 성공 시 재시도 윈도우 해제
    state.morning_checked = report.morning_done;
    state.evening_checked = report.evening_done;
}

/// checker WebView에 trigger-check 이벤트를 발송.
/// JS가 이벤트를 수신하면 API를 조회해
/// `report_attendance_status` invoke로 반환한다.
pub fn trigger_check(app: &tauri::AppHandle) {
    debug!("[checker] trigger_check emitted");
    let _ = app.emit_to(
        tauri::EventTarget::WebviewWindow {
            label: "checker".into(),
        },
        "trigger-check",
        (),
    );
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

/// 순수 로직: 체커 보고를 앱 상태에 반영하고 phase를 재계산.
///
/// API 에러 시 `data_loaded`만 설정하고 `None` 반환.
/// 그 외에는 `apply_report` + `compute_daily_phase`를 수행하고
/// `Some((phase, remaining))` 반환.
pub(crate) fn process_report(
    state: &mut AppState,
    report: &AttendanceReport,
    now: DateTime<Utc>,
) -> Option<(DailyPhase, Option<i64>)> {
    if report.api_error {
        state.data_loaded = true;
        return None;
    }

    apply_report(state, report);

    let (phase, remaining) =
        state::compute_daily_phase(&state.config, now, state.morning_checked, state.evening_checked);
    state.phase = phase;
    Some((phase, remaining))
}

/// Tauri 커맨드: API 조회 결과를 수신.
/// `trigger_check()`가 이벤트를 보내면, JS가 이 커맨드를 invoke로 호출한다.
#[tauri::command]
pub async fn report_attendance_status(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
    status: AttendanceReport,
) -> Result<(), String> {
    if status.api_error {
        info!("[checker] API error received, skipping state update");
    } else {
        let s = state.lock().await;
        info!(
            "[checker] report: needs_login={} morning={} evening={} current_phase={:?}",
            status.needs_login, status.morning_done, status.evening_done, s.phase,
        );
        drop(s);
    }

    let mut s = state.lock().await;
    let now = chrono::Utc::now();
    if let Some((phase, remaining)) = process_report(&mut s, &status, now) {
        tray::update_tray(&app, phase, remaining, s.needs_login);
    }

    Ok(())
}

/// Tauri 커맨드: 자동 업데이트 설정 조회.
#[tauri::command]
pub async fn get_auto_update(state: tauri::State<'_, Arc<Mutex<AppState>>>) -> Result<bool, String> {
    Ok(state.lock().await.config.auto_update)
}

/// Tauri 커맨드: 자동 업데이트 설정 변경 및 저장.
#[tauri::command]
pub async fn set_auto_update(state: tauri::State<'_, Arc<Mutex<AppState>>>, enabled: bool) -> Result<(), String> {
    log::info!("[settings] 자동 업데이트 설정 변경: {}", enabled);
    let mut s = state.lock().await;
    s.config.auto_update = enabled;
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

/// Tauri 커맨드: 업데이트 확인 후 결과를 시스템 다이얼로그로 표시.
/// 업데이트가 있으면 확인/취소 다이얼로그를 띄우고, 확인 시 설치.
/// download_and_install 성공 시 플랫폼이 자동으로 재시작/설치 진행하므로 app.restart() 불필요.
#[tauri::command]
pub async fn check_and_notify_update(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

    log::info!("[updater] 업데이트 확인 요청");
    let updater = app.updater().map_err(|e| e.to_string())?;
    let check_result = updater.check().await;

    tauri::async_runtime::spawn(async move {
        match check_result {
            Ok(Some(update)) => {
                log::info!("[updater] 새 업데이트 발견: v{}", update.version);

                // 릴리즈 후 30분 이내면 CI 빌드가 아직 진행 중일 수 있음
                let is_building = update.date.map_or(false, |date| {
                    let elapsed = chrono::Utc::now().timestamp() - date.unix_timestamp();
                    elapsed < 30 * 60
                });
                if is_building {
                    log::info!("[updater] 릴리즈 후 30분 미경과, 빌드 진행 중으로 판단");
                    app.dialog()
                        .message(format!(
                            "새로운 버전 v{}이 출시되었지만, 빌드가 진행 중입니다.\n잠시 후에 다시 시도해 주세요.",
                            update.version
                        ))
                        .title("업데이트 확인")
                        .show(|_| {});
                    return;
                }

                let version = update.version.clone();
                let (tx, rx) = tokio::sync::oneshot::channel::<bool>();
                app.dialog()
                    .message(format!(
                        "새로운 버전 v{}이 있습니다. 지금 설치하고 재시작하시겠습니까?",
                        version
                    ))
                    .title("업데이트 가능")
                    .buttons(MessageDialogButtons::OkCancelCustom(
                        "설치 및 재시작".into(),
                        "나중에".into(),
                    ))
                    .show(move |confirmed| {
                        let _ = tx.send(confirmed);
                    });
                if rx.await.unwrap_or(false) {
                    app.dialog()
                        .message("업데이트를 다운로드 중입니다.\n완료될 때까지 앱을 종료하지 마세요. (이 창은 닫아도 됩니다.)")
                        .title("업데이트 중")
                        .show(|_| {});
                    match update.download_and_install(|_, _| {}, || {}).await {
                        Ok(_) => {
                            log::info!("[updater] 업데이트 설치 완료, 앱 재시작");
                            app.restart();
                        }
                        Err(e) => {
                            log::error!("[updater] 업데이트 설치 실패: {}", e);
                            app.dialog()
                                .message(format!("업데이트 설치에 실패했습니다: {}", e))
                                .title("업데이트 오류")
                                .show(|_| {});
                        }
                    }
                }
            }
            Ok(None) => {
                log::info!("[updater] 최신 버전입니다");
                app.dialog()
                    .message("현재 최신 버전입니다.")
                    .title("업데이트 확인")
                    .show(|_| {});
            }
            Err(e) => {
                log::debug!("[updater] 업데이트 확인 실패: {}", e);
                app.dialog()
                    .message(format!("업데이트 확인에 실패했습니다.\n{}", e))
                    .title("업데이트 확인")
                    .show(|_| {});
            }
        }
    });

    Ok(())
}

/// Tauri 커맨드: 알림 활성화 설정 조회.
#[tauri::command]
pub async fn get_notification_enabled(state: tauri::State<'_, Arc<Mutex<AppState>>>) -> Result<bool, String> {
    Ok(state.lock().await.config.notification_enabled)
}

/// Tauri 커맨드: 알림 활성화 설정 변경 및 저장.
#[tauri::command]
pub async fn set_notification_enabled(
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
    enabled: bool,
) -> Result<(), String> {
    log::info!("[settings] 알림 설정 변경: {}", enabled);
    let mut s = state.lock().await;
    s.config.notification_enabled = enabled;
    s.config.save();
    Ok(())
}

/// Tauri 커맨드: 알림 간격(분) 조회.
#[tauri::command]
pub async fn get_notification_interval(state: tauri::State<'_, Arc<Mutex<AppState>>>) -> Result<u32, String> {
    Ok(state.lock().await.config.notification_interval_mins)
}

/// Tauri 커맨드: 알림 간격(분) 변경 및 저장.
#[tauri::command]
pub async fn set_notification_interval(
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
    minutes: u32,
) -> Result<(), String> {
    log::info!("[settings] 알림 간격 변경: {}분", minutes);
    let mut s = state.lock().await;
    s.config.notification_interval_mins = minutes;
    s.config.save();
    Ok(())
}

/// Tauri 커맨드: 알림 시작 시각 조회.
#[tauri::command]
pub async fn get_notification_start(state: tauri::State<'_, Arc<Mutex<AppState>>>) -> Result<TimeOfDay, String> {
    let s = state.lock().await;
    Ok(s.config.notification_start.clone())
}

/// Tauri 커맨드: 알림 시작 시각 변경 및 저장.
#[tauri::command]
pub async fn set_notification_start(
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
    hour: u32,
    minute: u32,
) -> Result<(), String> {
    log::info!("[settings] 알림 시작 시각 변경: {:02}:{:02}", hour, minute);
    let mut s = state.lock().await;
    s.config.notification_start = TimeOfDay { hour, minute };
    s.config.save();
    Ok(())
}

/// Tauri 커맨드: 알림 종료 시각 조회.
#[tauri::command]
pub async fn get_notification_end(state: tauri::State<'_, Arc<Mutex<AppState>>>) -> Result<TimeOfDay, String> {
    let s = state.lock().await;
    Ok(s.config.notification_end.clone())
}

/// Tauri 커맨드: 알림 종료 시각 변경 및 저장.
#[tauri::command]
pub async fn set_notification_end(
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
    hour: u32,
    minute: u32,
) -> Result<(), String> {
    log::info!("[settings] 알림 종료 시각 변경: {:02}:{:02}", hour, minute);
    let mut s = state.lock().await;
    s.config.notification_end = TimeOfDay { hour, minute };
    s.config.save();
    Ok(())
}

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

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{FixedOffset, TimeZone};
    use crate::config::Config;

    /// KST 시각을 UTC DateTime으로 변환하는 헬퍼.
    fn kst_time(h: u32, m: u32, s: u32) -> DateTime<Utc> {
        FixedOffset::east_opt(9 * 3600)
            .unwrap()
            .with_ymd_and_hms(2026, 3, 17, h, m, s)
            .unwrap()
            .with_timezone(&Utc)
    }

    fn default_state() -> AppState {
        AppState::new(Config::default())
    }

    #[test]
    fn api_에러시_데이터_로드_상태만_설정된다() {
        // given
        let mut state = default_state();
        let report = AttendanceReport {
            needs_login: false,
            morning_done: false,
            evening_done: false,
            api_error: true,
        };

        // when
        let result = process_report(&mut state, &report, kst_time(9, 0, 0));

        // then
        assert!(result.is_none());
        assert!(state.data_loaded);
    }

    #[test]
    fn 로그인_필요시_페이즈는_시간에_따라_계산된다() {
        // given
        let mut state = default_state();
        let report = AttendanceReport {
            needs_login: true,
            morning_done: false,
            evening_done: false,
            api_error: false,
        };

        // when
        let result = process_report(&mut state, &report, kst_time(9, 0, 0));

        // then
        assert!(result.is_some());
        let (phase, remaining) = result.unwrap();
        assert_eq!(phase, DailyPhase::NeedStart);
        assert!(remaining.is_some());
        assert!(state.needs_login);
    }

    #[test]
    fn 오전_출석_완료시_학습중_상태가_된다() {
        // given
        let mut state = default_state();
        let report = AttendanceReport {
            needs_login: false,
            morning_done: true,
            evening_done: false,
            api_error: false,
        };

        // when: KST 12:00 — 체크인 완료, 체크아웃 전
        let result = process_report(&mut state, &report, kst_time(12, 0, 0));

        // then
        let (phase, _) = result.unwrap();
        assert_eq!(phase, DailyPhase::Studying);
        assert!(state.morning_checked);
        assert!(!state.evening_checked);
    }

    #[test]
    fn 오전_오후_모두_완료시_완료_상태가_된다() {
        // given
        let mut state = default_state();
        let report = AttendanceReport {
            needs_login: false,
            morning_done: true,
            evening_done: true,
            api_error: false,
        };

        // when
        let result = process_report(&mut state, &report, kst_time(23, 30, 0));

        // then
        let (phase, _) = result.unwrap();
        assert_eq!(phase, DailyPhase::Complete);
    }

    #[test]
    fn 오전_마감_초과시_지각_상태가_된다() {
        // given
        let mut state = default_state();
        let report = AttendanceReport {
            needs_login: false,
            morning_done: false,
            evening_done: false,
            api_error: false,
        };

        // when: KST 11:00 — morning_end(10:00) 지남, 미체크인
        let result = process_report(&mut state, &report, kst_time(11, 0, 0));

        // then
        let (phase, _) = result.unwrap();
        assert_eq!(phase, DailyPhase::StartOverdue);
    }
}
