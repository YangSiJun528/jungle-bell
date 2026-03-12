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
