//! 체커 모듈 — 숨겨진 WebView의 DOM 스냅샷을 수신·처리.
//!
//! checker.js가 WebView에 주입되어 `window.__jungleCheck(debug)` 함수를 등록한다.
//! Rust가 `trigger_check()`로 이 함수를 호출하면,
//! JS가 DOM 스냅샷을 수집해 `report_attendance_status` invoke로 반환한다.
//! 이 모듈은 반환된 스냅샷을 처리하고 공유 앱 상태를 갱신한다.

use std::sync::Arc;

use log::{debug, info};
use serde::Deserialize;
use tauri::Emitter;
use tokio::sync::Mutex;

use tauri_plugin_autostart::ManagerExt as AutostartManagerExt;
use tauri_plugin_updater::UpdaterExt;

use crate::config::TimeOfDay;
use crate::state::{self, AppState};
use crate::tray;

/// checker.js의 `__jungleCheck()`가 반환하는 DOM 스냅샷.
/// JS invoke 호출의 JSON 페이로드에서 역직렬화됨.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct AttendanceReport {
    /// WebView가 로그인 페이지에 있는지 (미인증)
    pub needs_login: bool,
    /// 액션 버튼 텍스트 (예: "학습 시작", "학습 종료")
    pub button_text: Option<String>,
    /// 액션 버튼 비활성 여부
    pub is_disabled: bool,
    /// 출석 테이블에서 시작 시간 존재 여부
    #[serde(default)]
    pub morning_done: bool,
    /// 출석 테이블에서 종료 시간 존재 여부
    #[serde(default)]
    pub evening_done: bool,
    /// 현재 페이지 URL
    #[serde(default)]
    pub page_url: Option<String>,
    /// 페이지가 아직 로딩 중인지 (테이블·버튼 모두 없음)
    #[serde(default)]
    pub page_not_ready: bool,
}

/// 체커 보고를 공유 앱 상태에 반영.
pub fn apply_report(state: &mut AppState, report: &AttendanceReport) {
    state.data_loaded = true;

    if report.needs_login {
        state.needs_login = true;
        return;
    }

    state.needs_login = false;
    state.morning_checked = report.morning_done;
    state.evening_checked = report.evening_done;
}

/// checker WebView에 trigger-check 이벤트를 발송.
/// JS가 이벤트를 수신하면 DOM 스냅샷을 수집해
/// `report_attendance_status` invoke로 반환한다.
pub fn trigger_check(app: &tauri::AppHandle) {
    let _ = app.emit_to(
        tauri::EventTarget::WebviewWindow {
            label: "checker".into(),
        },
        "trigger-check",
        (),
    );
}

/// Tauri 커맨드: JS 스냅샷 결과를 수신.
/// `trigger_check()`가 JS를 실행하면, JS가 이 커맨드를 invoke로 호출한다.
#[tauri::command]
pub async fn report_attendance_status(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
    status: AttendanceReport,
) -> Result<(), String> {
    // 페이지 미로딩 시 상태 갱신하지 않음
    if status.page_not_ready {
        debug!(
            "page not ready, skipping: url={}",
            status.page_url.as_deref().unwrap_or("?")
        );
        return Ok(());
    }

    info!(
        "report: url={} needs_login={} button={:?} disabled={} morning={} evening={}",
        status.page_url.as_deref().unwrap_or("?"),
        status.needs_login,
        status.button_text,
        status.is_disabled,
        status.morning_done,
        status.evening_done,
    );

    let mut s = state.lock().await;
    apply_report(&mut s, &status);

    // 즉시 상태 재계산 + 트레이 갱신
    let now = chrono::Utc::now();
    let (phase, remaining) = state::compute_daily_phase(&s.config, now, s.morning_checked, s.evening_checked);
    s.phase = phase;
    tray::update_tray(&app, phase, remaining, s.needs_login);

    Ok(())
}

/// Tauri 커맨드: 자동 업데이트 설정 조회.
#[tauri::command]
pub async fn get_auto_update(state: tauri::State<'_, Arc<Mutex<AppState>>>) -> Result<bool, String> {
    Ok(state.lock().await.config.auto_update)
}

/// Tauri 커맨드: 자동 업데이트 설정 변경 및 저장.
#[tauri::command]
pub async fn set_auto_update(
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
    enabled: bool,
) -> Result<(), String> {
    log::info!("자동 업데이트 설정 변경: {}", enabled);
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
    log::info!("자동 시작 설정 변경: {}", enabled);
    // 앱 설정을 먼저 저장한 후 OS 설정을 변경한다.
    // OS 변경에 실패하더라도 다음 실행 시 setup에서 Config 기준으로 재동기화된다.
    {
        let mut s = state.lock().await;
        s.config.auto_start = enabled;
        s.config.save();
    }
    let autolaunch = app.autolaunch();
    let result = if enabled { autolaunch.enable() } else { autolaunch.disable() };
    result.map_err(|e| e.to_string())?;
    Ok(())
}

/// Tauri 커맨드: 업데이트 확인 후 결과를 시스템 다이얼로그로 표시.
/// 업데이트가 있으면 확인/취소 다이얼로그를 띄우고, 확인 시 설치.
/// download_and_install 성공 시 플랫폼이 자동으로 재시작/설치 진행하므로 app.restart() 불필요.
#[tauri::command]
pub async fn check_and_notify_update(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

    log::info!("업데이트 확인 요청");
    let updater = app.updater().map_err(|e| e.to_string())?;
    let check_result = updater.check().await;

    tauri::async_runtime::spawn(async move {
        match check_result {
            Ok(Some(update)) => {
                log::info!("새 업데이트 발견: v{}", update.version);
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
                    match update.download_and_install(|_, _| {}, || {}).await {
                        Ok(_) => {
                            log::info!("업데이트 설치 완료, 앱 재시작");
                            app.restart();
                        }
                        Err(e) => {
                            log::error!("업데이트 설치 실패: {}", e);
                            app.dialog()
                                .message(format!("업데이트 설치에 실패했습니다: {}", e))
                                .title("업데이트 오류")
                                .show(|_| {});
                        }
                    }
                }
            }
            Ok(None) => {
                log::info!("최신 버전입니다");
                app.dialog()
                    .message("현재 최신 버전입니다.")
                    .title("업데이트 확인")
                    .show(|_| {});
            }
            Err(e) => {
                log::debug!("업데이트 확인 실패: {}", e);
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
    log::info!("알림 설정 변경: {}", enabled);
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
    log::info!("알림 간격 변경: {}분", minutes);
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
    log::info!("알림 시작 시각 변경: {:02}:{:02}", hour, minute);
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
    log::info!("알림 종료 시각 변경: {:02}:{:02}", hour, minute);
    let mut s = state.lock().await;
    s.config.notification_end = TimeOfDay { hour, minute };
    s.config.save();
    Ok(())
}
