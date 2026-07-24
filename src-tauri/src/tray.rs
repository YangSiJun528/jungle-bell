//! 시스템 트레이 모듈 — 아이콘, 메뉴, 툴팁, 메뉴 이벤트 처리.
//!
//! 트레이 아이콘은 현재 상태에 따라 색상이 변경됨:
//!   - 회색 (오프라인/확인 중): checker 미보고, 복구 중, 확인 불가
//!   - 흰색 (정상): Idle, Studying, Complete
//!   - 오렌지 (경고): 로그인 필요
//!   - 빨간색 (긴급): NeedStart, StartOverdue, NeedEnd

use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex as TokioMutex;

use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};

use crate::analytics::{self, Event};
use crate::state::{AppState, CheckerRuntimeStatus, DailyPhase, DdayStatus, TraySnapshot};
use tauri::{
    image::Image,
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, PhysicalPosition, WebviewWindow,
};

const ATTENDANCE_URL: &str = "https://jungle-lms.krafton.com/check-in";
const DISCUSSIONS_URL: &str = "https://github.com/YangSiJun528/jungle-bell/discussions";

const UTILITY_WINDOW_WIDTH: f64 = 560.0;
const CONTENT_WINDOW_WIDTH: f64 = 720.0;
const STANDARD_WINDOW_HEIGHT: f64 = 720.0;
const ATTENDANCE_MIN_SIZE: f64 = 640.0;
const IMAGE_VIEWER_WIDTH: f64 = 1120.0;
const IMAGE_VIEWER_HEIGHT: f64 = 840.0;
const IMAGE_VIEWER_MIN_WIDTH: f64 = 420.0;
const IMAGE_VIEWER_MIN_HEIGHT: f64 = 320.0;
const TRAY_PANEL_WIDTH: f64 = 390.0;
const TRAY_PANEL_HEIGHT: f64 = 640.0;
const TRAY_PANEL_GAP: f64 = 8.0;
const TRAY_PANEL_HIDE_DELAY_MS: u64 = 120;

/// 출석 페이지 닫힌 후 로그인 재시도 윈도우 (초). 3분간 빠르게 재확인.
const LOGIN_RETRY_WINDOW_SECS: u64 = 180;

// 트레이 아이콘 — 컴파일 시 include_bytes!로 바이너리에 포함
const ICON_OFFLINE: &[u8] = include_bytes!("../icons/tray-gray.png");
const ICON_NORMAL: &[u8] = include_bytes!("../icons/tray-white.png");
const ICON_ALERT: &[u8] = include_bytes!("../icons/tray-red.png");
const ICON_WARNING: &[u8] = include_bytes!("../icons/tray-orange.png");

const FOREGROUND_WINDOW_LABELS: [&str; 5] = ["attendance", "settings", "onboarding", "campus", "image-viewer"];

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImageViewerPayload {
    image_url: String,
}

#[derive(Debug, Clone, Copy)]
enum CampusTab {
    Laundry,
    Meals,
}

impl CampusTab {
    fn as_str(self) -> &'static str {
        match self {
            Self::Laundry => "laundry",
            Self::Meals => "meals",
        }
    }
}

/// 커스텀 트레이 패널에 전달할 마지막 상태를 보관한다.
/// Tauri managed state로 저장: `Arc<TokioMutex<TrayState>>`.
pub struct TrayState {
    view: TrayViewModel,
    dday_visible: bool,
    pending_update: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TrayIconKind {
    Offline,
    Normal,
    Warning,
    Alert,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum TrayStatusKind {
    Loading,
    Recovering,
    Offline,
    NeedsLogin,
    Active,
    Complete,
    Normal,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TrayViewModel {
    status: TrayStatusKind,
    icon: TrayIconKind,
    status_text: String,
    dday_text: String,
    tooltip: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayPanelState {
    status: TrayStatusKind,
    status_text: String,
    dday_text: Option<String>,
    current_version: String,
    pending_update: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TrayPanelAction {
    OpenAttendance,
    OpenLaundry,
    OpenMeals,
    OpenDiscussions,
    OpenSettings,
    CheckUpdate,
    Quit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct PanelRect {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct PanelSize {
    width: u32,
    height: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct PanelPosition {
    x: i32,
    y: i32,
}

#[derive(Debug, Clone, Copy)]
struct MonitorGeometry {
    bounds: PanelRect,
}

fn rect_contains_point(rect: PanelRect, point: PanelPosition) -> bool {
    let left = i64::from(rect.x);
    let top = i64::from(rect.y);
    let right = left + i64::from(rect.width);
    let bottom = top + i64::from(rect.height);
    let x = i64::from(point.x);
    let y = i64::from(point.y);

    x >= left && x < right && y >= top && y < bottom
}

fn select_tray_monitor_index(
    monitors: &[MonitorGeometry],
    click_position: PanelPosition,
    tray_rect: PanelRect,
) -> Option<usize> {
    if let Some(index) = monitors
        .iter()
        .position(|monitor| rect_contains_point(monitor.bounds, click_position))
    {
        return Some(index);
    }

    // 메뉴바 최상단 경계 클릭은 커서가 화면 영역에서 1px 벗어날 수 있다.
    // 이 경우 트레이 아이콘 중앙을 두 번째 기준점으로 사용한다.
    let tray_center = PanelPosition {
        x: (i64::from(tray_rect.x) + i64::from(tray_rect.width) / 2).clamp(i64::from(i32::MIN), i64::from(i32::MAX))
            as i32,
        y: (i64::from(tray_rect.y) + i64::from(tray_rect.height) / 2).clamp(i64::from(i32::MIN), i64::from(i32::MAX))
            as i32,
    };

    monitors
        .iter()
        .position(|monitor| rect_contains_point(monitor.bounds, tray_center))
}

fn panel_size_for_scale(scale_factor: f64) -> PanelSize {
    let scale_factor = if scale_factor.is_finite() && scale_factor > 0.0 {
        scale_factor
    } else {
        1.0
    };

    PanelSize {
        width: (TRAY_PANEL_WIDTH * scale_factor).round() as u32,
        height: (TRAY_PANEL_HEIGHT * scale_factor).round() as u32,
    }
}

fn calculate_panel_position(anchor: PanelRect, panel: PanelSize, work_area: PanelRect, gap: i32) -> PanelPosition {
    let anchor_x = i64::from(anchor.x);
    let anchor_y = i64::from(anchor.y);
    let anchor_width = i64::from(anchor.width);
    let anchor_height = i64::from(anchor.height);
    let panel_width = i64::from(panel.width);
    let panel_height = i64::from(panel.height);
    let work_x = i64::from(work_area.x);
    let work_y = i64::from(work_area.y);
    let work_width = i64::from(work_area.width);
    let work_height = i64::from(work_area.height);
    let margin = i64::from(gap.max(0));

    let min_x = work_x + margin;
    let max_x = (work_x + work_width - panel_width - margin).max(min_x);
    let preferred_x = anchor_x + anchor_width / 2 - panel_width / 2;

    let min_y = work_y + margin;
    let max_y = (work_y + work_height - panel_height - margin).max(min_y);
    let tray_is_above_work_area_center = anchor_y + anchor_height / 2 <= work_y + work_height / 2;
    let preferred_y = if tray_is_above_work_area_center {
        anchor_y + anchor_height + margin
    } else {
        anchor_y - panel_height - margin
    };

    PanelPosition {
        x: preferred_x.clamp(min_x, max_x) as i32,
        y: preferred_y.clamp(min_y, max_y) as i32,
    }
}

fn icon_for_kind(kind: TrayIconKind) -> Image<'static> {
    let bytes = match kind {
        TrayIconKind::Offline => ICON_OFFLINE,
        TrayIconKind::Normal => ICON_NORMAL,
        TrayIconKind::Warning => ICON_WARNING,
        TrayIconKind::Alert => ICON_ALERT,
    };
    Image::from_bytes(bytes).expect("invalid icon PNG")
}

fn icon_kind_for_snapshot(snapshot: &TraySnapshot) -> TrayIconKind {
    if !snapshot.data_loaded || snapshot.checker_status.is_recovering_or_offline() {
        return TrayIconKind::Offline;
    }

    if snapshot.needs_login {
        return TrayIconKind::Warning;
    }

    match snapshot.phase {
        DailyPhase::NeedStart | DailyPhase::StartOverdue | DailyPhase::NeedEnd => TrayIconKind::Alert,
        _ => TrayIconKind::Normal,
    }
}

fn status_kind_for_snapshot(snapshot: &TraySnapshot) -> TrayStatusKind {
    match snapshot.checker_status {
        CheckerRuntimeStatus::Refreshing { .. } => return TrayStatusKind::Recovering,
        CheckerRuntimeStatus::Offline { .. } => return TrayStatusKind::Offline,
        CheckerRuntimeStatus::Loading
        | CheckerRuntimeStatus::PageLoaded { .. }
        | CheckerRuntimeStatus::Ready { .. } => return TrayStatusKind::Loading,
        CheckerRuntimeStatus::Healthy { .. } => {}
    }

    if !snapshot.data_loaded {
        return TrayStatusKind::Loading;
    }

    if snapshot.needs_login {
        return TrayStatusKind::NeedsLogin;
    }

    match snapshot.phase {
        DailyPhase::NeedStart | DailyPhase::StartOverdue | DailyPhase::NeedEnd => TrayStatusKind::Active,
        DailyPhase::Complete => TrayStatusKind::Complete,
        DailyPhase::Idle | DailyPhase::Studying => TrayStatusKind::Normal,
    }
}

fn checker_status_text(status: CheckerRuntimeStatus) -> &'static str {
    match status {
        CheckerRuntimeStatus::Loading
        | CheckerRuntimeStatus::PageLoaded { .. }
        | CheckerRuntimeStatus::Ready { .. } => "상태 확인 중...",
        CheckerRuntimeStatus::Refreshing { .. } => "상태 재확인 중...",
        CheckerRuntimeStatus::Offline { .. } => "상태 확인 불가",
        CheckerRuntimeStatus::Healthy { .. } => "대기 중",
    }
}

/// 출석 phase 기준 상태 텍스트 생성.
fn build_attendance_status_text(phase: DailyPhase, remaining: Option<i64>, needs_login: bool) -> String {
    if needs_login {
        return "⚠️ 로그인 필요".to_string();
    }

    let mins = remaining.map(|s| (s + 59) / 60);

    /// 분 단위 잔여시간을 "Xh Ym" 또는 "X분" 형식으로 포매팅.
    fn fmt_time(m: i64) -> String {
        let hours = m / 60;
        let rest = m % 60;
        if hours > 0 {
            format!("{}h {}m", hours, rest)
        } else {
            format!("{}분", m)
        }
    }

    match phase {
        DailyPhase::Idle => "대기 중".to_string(),
        DailyPhase::NeedStart => match mins {
            Some(m) => format!("학습 시작 가능 ({} 남음)", fmt_time(m)),
            None => "학습 시작 가능".to_string(),
        },
        DailyPhase::StartOverdue => match mins {
            Some(m) if m > 0 => format!("지각 임박 ({}분 남음)", m),
            _ => "학습 시작 지각!".to_string(),
        },
        DailyPhase::Studying => match mins {
            Some(m) => format!("학습 중 (종료 가능까지 {})", fmt_time(m)),
            None => "학습 중".to_string(),
        },
        DailyPhase::NeedEnd => match mins {
            Some(m) => format!("학습 종료 가능 ({} 남음)", fmt_time(m)),
            None => "학습 종료 가능".to_string(),
        },
        DailyPhase::Complete => "오늘 출석 완료".to_string(),
    }
}

/// 트레이 아이콘 툴팁과 커스텀 패널에 표시할 상태 텍스트 생성.
fn build_status_text(snapshot: &TraySnapshot) -> String {
    if snapshot.checker_status.is_recovering_or_offline() {
        return checker_status_text(snapshot.checker_status).to_string();
    }

    if !snapshot.data_loaded {
        return "상태 확인 중...".to_string();
    }

    build_attendance_status_text(snapshot.phase, snapshot.remaining, snapshot.needs_login)
}

/// 툴팁 텍스트 생성 (트레이 아이콘에 마우스 올릴 때 표시).
fn build_tooltip(status_text: &str) -> String {
    let status = status_text;
    format!("Jungle Bell - {}", status)
}

fn build_dday_text_for_date(status: &DdayStatus, today: NaiveDate) -> String {
    match status {
        DdayStatus::Unknown => "D-day 확인 중...".to_string(),
        DdayStatus::LoginRequired => "로그인 후 D-day 표시".to_string(),
        DdayStatus::Ended | DdayStatus::NoCohort => "진행 중인 코스 없음".to_string(),
        DdayStatus::Active { end_date } => {
            let days = end_date.signed_duration_since(today).num_days();
            if days > 0 {
                format!("수료까지 D-{}", days)
            } else if days == 0 {
                "수료 D-Day".to_string()
            } else {
                "진행 중인 코스 없음".to_string()
            }
        }
    }
}

fn build_dday_text(status: &DdayStatus, now: DateTime<Utc>) -> String {
    build_dday_text_for_date(status, now.with_timezone(&crate::state::kst()).date_naive())
}

fn build_tray_view_model(snapshot: &TraySnapshot, now: DateTime<Utc>) -> TrayViewModel {
    let status_text = build_status_text(snapshot);
    TrayViewModel {
        status: status_kind_for_snapshot(snapshot),
        icon: icon_kind_for_snapshot(snapshot),
        dday_text: build_dday_text(&snapshot.dday_status, now),
        tooltip: build_tooltip(&status_text),
        status_text,
    }
}

impl TrayState {
    fn panel_state(&self, current_version: String) -> TrayPanelState {
        TrayPanelState {
            status: self.view.status,
            status_text: self.view.status_text.clone(),
            dday_text: self.dday_visible.then(|| self.view.dday_text.clone()),
            current_version,
            pending_update: self.pending_update.clone(),
        }
    }
}

fn emit_tray_panel_state(app: &tauri::AppHandle, state: TrayPanelState) {
    if let Err(error) = app.emit_to("tray-panel", "tray-panel-state", state) {
        log::debug!("[tray-panel] state emit skipped: {error}");
    }
}

fn current_tray_panel_state(app: &tauri::AppHandle) -> Option<TrayPanelState> {
    let tray_state: tauri::State<Arc<TokioMutex<TrayState>>> = app.state();
    tray_state
        .try_lock()
        .ok()
        .map(|state| state.panel_state(app.package_info().version.to_string()))
}

fn refresh_tray_panel(app: &tauri::AppHandle) {
    if let Some(state) = current_tray_panel_state(app) {
        emit_tray_panel_state(app, state);
    }
}

fn focus_window_checked(window: &WebviewWindow<tauri::Wry>) -> Result<(), String> {
    window.show().map_err(|error| format!("창 표시 실패: {error}"))?;
    if window
        .is_minimized()
        .map_err(|error| format!("창 최소화 상태 확인 실패: {error}"))?
    {
        window
            .unminimize()
            .map_err(|error| format!("창 최소화 해제 실패: {error}"))?;
    }

    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::NSApplication;
        use objc2_foundation::MainThreadMarker;

        if let Some(mtm) = MainThreadMarker::new() {
            let ns_app = NSApplication::sharedApplication(mtm);
            ns_app.activate();
        } else {
            window
                .run_on_main_thread(|| {
                    if let Some(mtm) = MainThreadMarker::new() {
                        let ns_app = NSApplication::sharedApplication(mtm);
                        ns_app.activate();
                    }
                })
                .map_err(|error| format!("macOS 앱 활성화 예약 실패: {error}"))?;
        }
    }

    window.set_focus().map_err(|error| format!("창 포커스 실패: {error}"))
}

fn focus_window(window: &WebviewWindow<tauri::Wry>) {
    if let Err(error) = focus_window_checked(window) {
        log::warn!("[tray] window focus failed ({}): {}", window.label(), error);
    }
}

#[cfg(target_os = "macos")]
fn has_foreground_window(app: &tauri::AppHandle) -> bool {
    FOREGROUND_WINDOW_LABELS
        .iter()
        .any(|label| app.get_webview_window(label).is_some())
}

fn should_show_foreground_app(show_app_icon: bool, has_foreground_window: bool) -> bool {
    show_app_icon || has_foreground_window
}

#[cfg(any(target_os = "windows", test))]
fn should_skip_windows_taskbar(show_app_icon: bool) -> bool {
    !show_app_icon
}

fn foreground_window_skip_taskbar(app: &tauri::AppHandle) -> bool {
    #[cfg(target_os = "windows")]
    {
        let state: tauri::State<Arc<TokioMutex<AppState>>> = app.state();
        let show_app_icon = state.try_lock().map(|s| s.config.show_app_icon).unwrap_or(true);
        return should_skip_windows_taskbar(show_app_icon);
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        false
    }
}

#[cfg(target_os = "windows")]
fn set_windows_taskbar_visibility(app: &tauri::AppHandle, visible: bool) -> Result<(), String> {
    let skip_taskbar = should_skip_windows_taskbar(visible);
    for label in FOREGROUND_WINDOW_LABELS {
        if let Some(window) = app.get_webview_window(label) {
            if let Err(error) = window.set_skip_taskbar(skip_taskbar) {
                let rollback_skip_taskbar = !skip_taskbar;
                for rollback_label in FOREGROUND_WINDOW_LABELS {
                    if let Some(rollback_window) = app.get_webview_window(rollback_label) {
                        let _ = rollback_window.set_skip_taskbar(rollback_skip_taskbar);
                    }
                }
                return Err(format!("작업 표시줄 표시 변경 실패({label}): {error}"));
            }
        }
    }

    Ok(())
}

pub fn set_app_icon_visibility(app: &tauri::AppHandle, visible: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let app_for_task = app.clone();
        app.run_on_main_thread(move || {
            set_macos_foreground_visibility(
                &app_for_task,
                should_show_foreground_app(visible, has_foreground_window(&app_for_task)),
            );
        })
        .map_err(|error| format!("앱 아이콘 표시 변경 예약 실패: {error}"))?;
    }

    #[cfg(target_os = "windows")]
    set_windows_taskbar_visibility(app, visible)?;

    Ok(())
}

#[cfg(target_os = "macos")]
fn set_macos_foreground_visibility(app: &tauri::AppHandle, visible: bool) {
    let policy = if visible {
        tauri::ActivationPolicy::Regular
    } else {
        tauri::ActivationPolicy::Accessory
    };

    if let Err(e) = app.set_activation_policy(policy) {
        log::warn!("[tray] macOS activation policy 변경 실패: {}", e);
    }
    if let Err(e) = app.set_dock_visibility(visible) {
        log::warn!("[tray] macOS Dock 표시 변경 실패: {}", e);
    }
}

pub fn sync_foreground_app_visibility(app: &tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    {
        let show_app_icon = {
            let state: tauri::State<Arc<TokioMutex<AppState>>> = app.state();
            state.try_lock().map(|s| s.config.show_app_icon).unwrap_or(true)
        };
        set_macos_foreground_visibility(
            app,
            should_show_foreground_app(show_app_icon, has_foreground_window(app)),
        );
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
    }
}

#[cfg(target_os = "macos")]
fn show_foreground_app(app: &tauri::AppHandle) {
    set_macos_foreground_visibility(app, true);
}

#[cfg(not(target_os = "macos"))]
fn show_foreground_app(app: &tauri::AppHandle) {
    let _ = app;
}

fn sync_foreground_app_visibility_soon(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(50)).await;
        sync_foreground_app_visibility(&app);
    });
}

fn activate_login_retry_window(app_handle: &tauri::AppHandle) {
    let state: tauri::State<Arc<TokioMutex<AppState>>> = app_handle.state();
    if let Ok(mut s) = state.try_lock() {
        s.login_retry_until = Some(chrono::Utc::now() + chrono::Duration::seconds(LOGIN_RETRY_WINDOW_SECS as i64));
    };
}

fn reload_checker(app_handle: &tauri::AppHandle) {
    crate::checker::refresh_webview(app_handle, "attendance window closed");
}

pub fn refresh_login_status(app_handle: &tauri::AppHandle) {
    activate_login_retry_window(app_handle);
    reload_checker(app_handle);
}

fn build_attendance_window(app: &tauri::AppHandle) {
    show_foreground_app(app);
    let app_handle = app.clone();
    if let Ok(window) = tauri::WebviewWindowBuilder::new(
        app,
        "attendance",
        tauri::WebviewUrl::External(ATTENDANCE_URL.parse().unwrap()),
    )
    .title("Jungle Compass")
    .theme(Some(tauri::Theme::Light))
    .inner_size(CONTENT_WINDOW_WIDTH, STANDARD_WINDOW_HEIGHT)
    .min_inner_size(ATTENDANCE_MIN_SIZE, ATTENDANCE_MIN_SIZE)
    .resizable(true)
    .skip_taskbar(foreground_window_skip_taskbar(app))
    .focused(true)
    .build()
    {
        focus_window(&window);
        window.on_window_event(move |event| {
            if let tauri::WindowEvent::Destroyed = event {
                log::info!("[tray] attendance page closed, reloading checker + activating login retry");
                reload_checker(&app_handle);
                activate_login_retry_window(&app_handle);
                sync_foreground_app_visibility_soon(app_handle.clone());
            }
        });
    }
}

pub fn open_attendance_window(app: &tauri::AppHandle) {
    log::info!("[tray] attendance window opened");
    analytics::track(Event::AttendancePageOpened);

    if let Some(window) = app.get_webview_window("attendance") {
        show_foreground_app(app);
        focus_window(&window);
    } else {
        build_attendance_window(app);
    }
}

pub fn open_image_viewer(app: &tauri::AppHandle, image_url: String) -> Result<(), String> {
    let payload = ImageViewerPayload { image_url };

    show_foreground_app(app);
    if let Some(window) = app.get_webview_window("image-viewer") {
        app.emit_to("image-viewer", "image-viewer-update", &payload)
            .map_err(|error| format!("이미지 갱신 실패: {error}"))?;
        focus_window_checked(&window)?;
        return Ok(());
    }

    let mut viewer_url = reqwest::Url::parse("http://localhost/image-viewer.html")
        .map_err(|error| format!("이미지 뷰어 주소 생성 실패: {error}"))?;
    viewer_url.query_pairs_mut().append_pair("src", &payload.image_url);
    let app_url = format!(
        "image-viewer.html?{}",
        viewer_url
            .query()
            .ok_or_else(|| "이미지 뷰어 주소를 만들지 못했습니다.".to_string())?
    );

    let window = tauri::WebviewWindowBuilder::new(app, "image-viewer", tauri::WebviewUrl::App(app_url.into()))
        .title("이미지 뷰어")
        .theme(Some(tauri::Theme::Light))
        .inner_size(IMAGE_VIEWER_WIDTH, IMAGE_VIEWER_HEIGHT)
        .min_inner_size(IMAGE_VIEWER_MIN_WIDTH, IMAGE_VIEWER_MIN_HEIGHT)
        .center()
        .prevent_overflow()
        .resizable(true)
        .minimizable(true)
        .maximizable(true)
        .skip_taskbar(foreground_window_skip_taskbar(app))
        .focused(true)
        .build()
        .map_err(|error| format!("이미지 창 생성 실패: {error}"))?;

    focus_window_checked(&window)?;
    let app_handle = app.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::Destroyed = event {
            sync_foreground_app_visibility_soon(app_handle.clone());
        }
    });
    Ok(())
}

fn select_campus_tab(window: &WebviewWindow<tauri::Wry>, tab: CampusTab) {
    let script = format!("window.setCampusTab && window.setCampusTab('{}')", tab.as_str());
    if let Err(error) = window.eval(&script) {
        log::warn!("[tray] campus tab selection failed: {}", error);
    }
}

fn build_campus_window(app: &tauri::AppHandle, tab: CampusTab) {
    show_foreground_app(app);
    if let Ok(window) = tauri::WebviewWindowBuilder::new(
        app,
        "campus",
        tauri::WebviewUrl::App(format!("campus.html?tab={}", tab.as_str()).into()),
    )
    .title("생활 정보")
    .theme(Some(tauri::Theme::Light))
    .inner_size(CONTENT_WINDOW_WIDTH, STANDARD_WINDOW_HEIGHT)
    .resizable(false)
    .minimizable(true)
    .maximizable(false)
    .skip_taskbar(foreground_window_skip_taskbar(app))
    .focused(true)
    .build()
    {
        focus_window(&window);
        let app_handle = app.clone();
        window.on_window_event(move |event| {
            if let tauri::WindowEvent::Destroyed = event {
                sync_foreground_app_visibility_soon(app_handle.clone());
            }
        });
    }
}

fn open_campus_window(app: &tauri::AppHandle, tab: CampusTab) {
    log::info!("[tray] campus window opened: {}", tab.as_str());
    match tab {
        CampusTab::Laundry => analytics::track(Event::LaundryStatusOpened),
        CampusTab::Meals => analytics::track(Event::MealPlanOpened),
    }

    if let Some(window) = app.get_webview_window("campus") {
        show_foreground_app(app);
        select_campus_tab(&window, tab);
        focus_window(&window);
    } else {
        build_campus_window(app, tab);
    }
}

fn build_settings_window(app: &tauri::AppHandle) {
    show_foreground_app(app);
    if let Ok(window) = tauri::WebviewWindowBuilder::new(app, "settings", tauri::WebviewUrl::App("index.html".into()))
        .title("설정")
        .theme(Some(tauri::Theme::Light))
        .inner_size(UTILITY_WINDOW_WIDTH, STANDARD_WINDOW_HEIGHT)
        .resizable(false)
        .minimizable(false)
        .maximizable(false)
        .skip_taskbar(foreground_window_skip_taskbar(app))
        .focused(true)
        .build()
    {
        focus_window(&window);
        let app_handle = app.clone();
        window.on_window_event(move |event| {
            if let tauri::WindowEvent::Destroyed = event {
                sync_foreground_app_visibility_soon(app_handle.clone());
            }
        });
    }
}

fn build_onboarding_window(app: &tauri::AppHandle) {
    show_foreground_app(app);
    if let Ok(window) =
        tauri::WebviewWindowBuilder::new(app, "onboarding", tauri::WebviewUrl::App("onboarding.html".into()))
            .title("Jungle Bell 시작하기")
            .theme(Some(tauri::Theme::Light))
            .inner_size(UTILITY_WINDOW_WIDTH, STANDARD_WINDOW_HEIGHT)
            .resizable(false)
            .minimizable(false)
            .maximizable(false)
            .skip_taskbar(foreground_window_skip_taskbar(app))
            .focused(true)
            .build()
    {
        focus_window(&window);
        let app_handle = app.clone();
        window.on_window_event(move |event| {
            if let tauri::WindowEvent::Destroyed = event {
                sync_foreground_app_visibility_soon(app_handle.clone());
            }
        });
    }
}

pub fn open_onboarding_window(app: &tauri::AppHandle) {
    log::info!("[tray] onboarding window opened");
    if let Some(window) = app.get_webview_window("onboarding") {
        show_foreground_app(app);
        focus_window(&window);
    } else {
        build_onboarding_window(app);
    }
    analytics::track(Event::OnboardingStarted);
}

fn open_settings_window(app: &tauri::AppHandle) {
    log::info!("[tray] settings window opened");
    analytics::track(Event::SettingsOpened);

    if let Some(window) = app.get_webview_window("settings") {
        show_foreground_app(app);
        focus_window(&window);
    } else {
        build_settings_window(app);
    }
}

fn run_window_task<F>(app: &tauri::AppHandle, task: F)
where
    F: FnOnce(tauri::AppHandle) + Send + 'static,
{
    let app_handle = app.clone();
    if let Err(e) = app.run_on_main_thread(move || task(app_handle)) {
        log::warn!("[tray] window task scheduling failed: {}", e);
    }
}

fn build_tray_panel_window(app: &tauri::AppHandle) -> tauri::Result<()> {
    if app.get_webview_window("tray-panel").is_some() {
        return Ok(());
    }

    let builder = tauri::WebviewWindowBuilder::new(app, "tray-panel", tauri::WebviewUrl::App("tray-panel.html".into()))
        .title("Jungle Bell")
        .theme(Some(tauri::Theme::Light))
        .inner_size(TRAY_PANEL_WIDTH, TRAY_PANEL_HEIGHT)
        .resizable(false)
        .minimizable(false)
        .maximizable(false)
        .closable(false)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        // macOS 네이티브 그림자는 투명 WebView의 사각 창 경계를 따라가므로 끈다.
        // 패널 모서리는 tray-panel.html의 투명 여백과 border-radius로 표현한다.
        .shadow(false)
        .transparent(true)
        .visible(false)
        .focused(false);

    let window = builder.build()?;

    let window_for_event = window.clone();
    window.on_window_event(move |event| match event {
        tauri::WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            let _ = window_for_event.hide();
        }
        tauri::WindowEvent::Focused(false) => {
            let window = window_for_event.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_millis(TRAY_PANEL_HIDE_DELAY_MS)).await;
                if matches!(window.is_focused(), Ok(false)) {
                    let _ = window.hide();
                }
            });
        }
        _ => {}
    });

    Ok(())
}

fn toggle_tray_panel(
    app: &tauri::AppHandle,
    click_position: tauri::PhysicalPosition<f64>,
    tray_rect: tauri::Rect,
) -> Result<(), String> {
    let window = app
        .get_webview_window("tray-panel")
        .ok_or_else(|| "트레이 패널 창을 찾지 못했습니다.".to_string())?;

    if window
        .is_visible()
        .map_err(|error| format!("트레이 패널 표시 상태 확인 실패: {error}"))?
    {
        window
            .hide()
            .map_err(|error| format!("트레이 패널 숨김 실패: {error}"))?;
        return Ok(());
    }

    // 멀티 모니터 좌표 처리 참고:
    // - SwitchHosts 구현:
    //   https://github.com/oldj/SwitchHosts/blob/master/src-tauri/src/tray.rs
    // - 동일 증상을 수정한 SwitchHosts 커밋:
    //   https://github.com/oldj/SwitchHosts/commit/cf3d22ce
    // - Tauri 관련 이슈:
    //   https://github.com/tauri-apps/tauri/issues/7139
    //
    // `monitor_from_point`는 macOS에서 논리 Quartz 좌표를 기대하지만,
    // TrayIconEvent는 Retina 배율이 적용된 물리 좌표를 전달한다.
    // 따라서 각 모니터의 물리 영역과 직접 비교해 클릭한 모니터를 찾는다.
    let monitors = app
        .available_monitors()
        .map_err(|error| format!("모니터 목록 확인 실패: {error}"))?;
    let monitor_geometries: Vec<_> = monitors
        .iter()
        .map(|monitor| {
            let position = monitor.position();
            let size = monitor.size();
            MonitorGeometry {
                bounds: PanelRect {
                    x: position.x,
                    y: position.y,
                    width: size.width,
                    height: size.height,
                },
            }
        })
        .collect();
    let raw_anchor_position = tray_rect.position.to_physical::<f64>(1.0);
    let raw_anchor_size = tray_rect.size.to_physical::<u32>(1.0);
    let raw_anchor = PanelRect {
        x: raw_anchor_position.x.round() as i32,
        y: raw_anchor_position.y.round() as i32,
        width: raw_anchor_size.width,
        height: raw_anchor_size.height,
    };
    let selected_index = select_tray_monitor_index(
        &monitor_geometries,
        PanelPosition {
            x: click_position.x.round() as i32,
            y: click_position.y.round() as i32,
        },
        raw_anchor,
    );
    let monitor = selected_index
        .and_then(|index| monitors.get(index).cloned())
        .or_else(|| app.primary_monitor().ok().flatten())
        .ok_or_else(|| "트레이가 있는 모니터를 찾지 못했습니다.".to_string())?;
    let scale_factor = monitor.scale_factor();
    let anchor_position = tray_rect.position.to_physical::<f64>(scale_factor);
    let anchor_size = tray_rect.size.to_physical::<u32>(scale_factor);
    let panel_size = panel_size_for_scale(scale_factor);
    let work_area = monitor.work_area();
    let gap = (TRAY_PANEL_GAP * scale_factor).round() as i32;

    log::debug!(
        "[tray-panel] monitor selected: index={selected_index:?} click=({:.0},{:.0}) anchor={raw_anchor:?} \
         bounds=({},{},{}x{}) scale={scale_factor}",
        click_position.x,
        click_position.y,
        monitor.position().x,
        monitor.position().y,
        monitor.size().width,
        monitor.size().height,
    );

    let position = calculate_panel_position(
        PanelRect {
            x: anchor_position.x.round() as i32,
            y: anchor_position.y.round() as i32,
            width: anchor_size.width,
            height: anchor_size.height,
        },
        panel_size,
        PanelRect {
            x: work_area.position.x,
            y: work_area.position.y,
            width: work_area.size.width,
            height: work_area.size.height,
        },
        gap,
    );

    window
        .set_position(PhysicalPosition::new(position.x, position.y))
        .map_err(|error| format!("트레이 패널 위치 설정 실패: {error}"))?;
    refresh_tray_panel(app);
    window
        .show()
        .map_err(|error| format!("트레이 패널 표시 실패: {error}"))?;
    window
        .set_focus()
        .map_err(|error| format!("트레이 패널 포커스 실패: {error}"))?;
    Ok(())
}

pub fn hide_tray_panel(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("tray-panel") {
        window
            .hide()
            .map_err(|error| format!("트레이 패널 숨김 실패: {error}"))?;
    }
    Ok(())
}

pub async fn get_tray_panel_state(app: &tauri::AppHandle) -> Result<TrayPanelState, String> {
    let tray_state: tauri::State<'_, Arc<TokioMutex<TrayState>>> = app.state();
    let state = tray_state.lock().await;
    Ok(state.panel_state(app.package_info().version.to_string()))
}

pub fn run_tray_panel_action(app: &tauri::AppHandle, action: TrayPanelAction) -> Result<(), String> {
    hide_tray_panel(app)?;

    match action {
        TrayPanelAction::OpenAttendance => run_window_task(app, |app| open_attendance_window(&app)),
        TrayPanelAction::OpenLaundry => run_window_task(app, |app| open_campus_window(&app, CampusTab::Laundry)),
        TrayPanelAction::OpenMeals => run_window_task(app, |app| open_campus_window(&app, CampusTab::Meals)),
        TrayPanelAction::OpenDiscussions => {
            analytics::track(Event::FeedbackOpened);
            tauri_plugin_opener::open_url(DISCUSSIONS_URL, None::<&str>).map_err(|error| error.to_string())?;
        }
        TrayPanelAction::OpenSettings => run_window_task(app, |app| open_settings_window(&app)),
        TrayPanelAction::CheckUpdate => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                crate::updater::prompt_and_install_update(app, false).await;
            });
        }
        TrayPanelAction::Quit => app.exit(0),
    }

    Ok(())
}

/// 시스템 트레이 생성: 상태 아이콘과 커스텀 패널 토글 이벤트를 설정한다.
pub fn setup_tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let (initial_view, show_dday, pending_update) = {
        let state: tauri::State<Arc<TokioMutex<AppState>>> = app.state();
        let state = state.try_lock().map_err(|_| "초기 앱 상태 잠금 실패")?;
        (
            build_tray_view_model(&state.tray_snapshot(None), Utc::now()),
            state.config.show_dday,
            state.pending_update.clone(),
        )
    };

    let tray_state = Arc::new(TokioMutex::new(TrayState {
        view: initial_view,
        dday_visible: show_dday,
        pending_update,
    }));
    app.manage(tray_state);
    build_tray_panel_window(app.handle())?;

    let _tray = TrayIconBuilder::with_id("main-tray")
        .icon(Image::from_bytes(ICON_OFFLINE).expect("invalid icon PNG"))
        .tooltip("Jungle Bell - 상태 확인 중...")
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                position,
                rect,
                button,
                button_state,
                ..
            } = event
            {
                let supported_button = matches!(button, MouseButton::Left | MouseButton::Right);
                if supported_button && button_state == MouseButtonState::Up {
                    if let Err(error) = toggle_tray_panel(tray.app_handle(), position, rect) {
                        log::warn!("[tray-panel] toggle failed: {error}");
                    }
                }
            }
        })
        .build(app)?;

    Ok(())
}

pub async fn sync_dday_panel_visibility(app: &tauri::AppHandle, visible: bool) -> Result<(), String> {
    let tray_state: tauri::State<Arc<TokioMutex<TrayState>>> = app.state();
    let mut ts = tray_state.lock().await;
    if visible == ts.dday_visible {
        return Ok(());
    }
    ts.dday_visible = visible;
    let panel_state = ts.panel_state(app.package_info().version.to_string());
    drop(ts);
    emit_tray_panel_state(app, panel_state);
    Ok(())
}

/// 커스텀 트레이 패널의 업데이트 알림 상태를 갱신한다.
pub fn update_tray_version(app: &tauri::AppHandle, pending_update: Option<String>) {
    let tray_state: tauri::State<Arc<TokioMutex<TrayState>>> = app.state();
    let panel_state = if let Ok(mut ts) = tray_state.try_lock() {
        ts.pending_update = pending_update;
        Some(ts.panel_state(app.package_info().version.to_string()))
    } else {
        None
    };
    if let Some(panel_state) = panel_state {
        emit_tray_panel_state(app, panel_state);
    }
}

/// 트레이 아이콘, 툴팁, 커스텀 패널 상태를 갱신한다.
/// 스케줄러(주기적)와 체커(보고 시) 양쪽에서 호출됨.
pub fn update_tray(app: &tauri::AppHandle, snapshot: &TraySnapshot) {
    let view = build_tray_view_model(snapshot, Utc::now());

    if let Some(tray) = app.tray_by_id("main-tray") {
        let _ = tray.set_icon(Some(icon_for_kind(view.icon)));
        let _ = tray.set_tooltip(Some(&view.tooltip));
    }

    // try_lock 사용 — 락이 잡혀 있으면 이번 주기 갱신은 건너뜀.
    let tray_state: tauri::State<Arc<TokioMutex<TrayState>>> = app.state();
    let panel_state = if let Ok(mut ts) = tray_state.try_lock() {
        ts.view = view;
        Some(ts.panel_state(app.package_info().version.to_string()))
    } else {
        None
    };
    if let Some(panel_state) = panel_state {
        emit_tray_panel_state(app, panel_state);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(
        phase: DailyPhase,
        remaining: Option<i64>,
        data_loaded: bool,
        needs_login: bool,
        checker_status: CheckerRuntimeStatus,
    ) -> TraySnapshot {
        TraySnapshot {
            phase,
            remaining,
            dday_status: DdayStatus::Unknown,
            data_loaded,
            needs_login,
            checker_status,
        }
    }

    fn healthy_snapshot(phase: DailyPhase, remaining: Option<i64>, needs_login: bool) -> TraySnapshot {
        snapshot(
            phase,
            remaining,
            true,
            needs_login,
            CheckerRuntimeStatus::Healthy { generation: 1 },
        )
    }

    #[test]
    fn 앱_아이콘_설정과_전면_창_상태로_macos_노출_여부를_결정한다() {
        assert!(should_show_foreground_app(true, false));
        assert!(should_show_foreground_app(false, true));
        assert!(!should_show_foreground_app(false, false));
    }

    #[test]
    fn 앱_아이콘_설정을_windows_skip_taskbar_값으로_변환한다() {
        assert!(!should_skip_windows_taskbar(true));
        assert!(should_skip_windows_taskbar(false));
    }

    #[test]
    fn 이미지_창은_넓은_기본_크기로_열린다() {
        assert_eq!(IMAGE_VIEWER_WIDTH, 1120.0);
        assert_eq!(IMAGE_VIEWER_HEIGHT, 840.0);
    }

    // --- TrayViewModel ---

    #[test]
    fn 데이터_미로드는_회색_확인중으로_표시한다() {
        let view = build_tray_view_model(
            &snapshot(DailyPhase::Idle, None, false, false, CheckerRuntimeStatus::Loading),
            Utc::now(),
        );

        assert_eq!(view.icon, TrayIconKind::Offline);
        assert_eq!(view.status_text, "상태 확인 중...");
        assert_eq!(view.tooltip, "Jungle Bell - 상태 확인 중...");
    }

    #[test]
    fn checker_갱신중은_회색_재확인으로_표시한다() {
        let view = build_tray_view_model(
            &snapshot(
                DailyPhase::NeedStart,
                Some(3600),
                true,
                false,
                CheckerRuntimeStatus::Refreshing {
                    generation: 2,
                    attempt: 1,
                },
            ),
            Utc::now(),
        );

        assert_eq!(view.icon, TrayIconKind::Offline);
        assert_eq!(view.status_text, "상태 재확인 중...");
    }

    #[test]
    fn checker_offline은_회색_확인불가로_표시한다() {
        let view = build_tray_view_model(
            &snapshot(
                DailyPhase::NeedStart,
                Some(3600),
                true,
                false,
                CheckerRuntimeStatus::Offline { generation: 2 },
            ),
            Utc::now(),
        );

        assert_eq!(view.icon, TrayIconKind::Offline);
        assert_eq!(view.status_text, "상태 확인 불가");
    }

    #[test]
    fn 로그인_필요시_주황_로그인_메시지를_표시한다() {
        let view = build_tray_view_model(&healthy_snapshot(DailyPhase::NeedStart, Some(3600), true), Utc::now());

        assert_eq!(view.icon, TrayIconKind::Warning);
        assert_eq!(view.status_text, "⚠️ 로그인 필요");
    }

    #[test]
    fn 출석_액션_필요시_빨간_아이콘을_표시한다() {
        let view = build_tray_view_model(&healthy_snapshot(DailyPhase::NeedStart, Some(1800), false), Utc::now());

        assert_eq!(view.icon, TrayIconKind::Alert);
        assert_eq!(view.status_text, "학습 시작 가능 (30분 남음)");
    }

    #[test]
    fn 정상_학습중은_흰색_아이콘을_표시한다() {
        let view = build_tray_view_model(&healthy_snapshot(DailyPhase::Studying, Some(5400), false), Utc::now());

        assert_eq!(view.icon, TrayIconKind::Normal);
        assert_eq!(view.status_text, "학습 중 (종료 가능까지 1h 30m)");
    }

    #[test]
    fn 출석완료_상태를_표시한다() {
        let view = build_tray_view_model(&healthy_snapshot(DailyPhase::Complete, None, false), Utc::now());

        assert_eq!(view.icon, TrayIconKind::Normal);
        assert_eq!(view.status_text, "오늘 출석 완료");
    }

    #[test]
    fn view_model은_표시상태를_명시적으로_분리한다() {
        let loading = build_tray_view_model(
            &snapshot(DailyPhase::Idle, None, false, false, CheckerRuntimeStatus::Loading),
            Utc::now(),
        );
        let recovering = build_tray_view_model(
            &snapshot(
                DailyPhase::NeedStart,
                Some(3600),
                true,
                false,
                CheckerRuntimeStatus::Refreshing {
                    generation: 2,
                    attempt: 1,
                },
            ),
            Utc::now(),
        );
        let offline = build_tray_view_model(
            &snapshot(
                DailyPhase::NeedStart,
                Some(3600),
                true,
                false,
                CheckerRuntimeStatus::Offline { generation: 2 },
            ),
            Utc::now(),
        );
        let needs_login = build_tray_view_model(&healthy_snapshot(DailyPhase::NeedStart, Some(3600), true), Utc::now());
        let active = build_tray_view_model(&healthy_snapshot(DailyPhase::NeedEnd, Some(1800), false), Utc::now());
        let complete = build_tray_view_model(&healthy_snapshot(DailyPhase::Complete, None, false), Utc::now());

        assert_eq!(loading.status, TrayStatusKind::Loading);
        assert_eq!(recovering.status, TrayStatusKind::Recovering);
        assert_eq!(offline.status, TrayStatusKind::Offline);
        assert_eq!(needs_login.status, TrayStatusKind::NeedsLogin);
        assert_eq!(active.status, TrayStatusKind::Active);
        assert_eq!(complete.status, TrayStatusKind::Complete);
    }

    // --- build_dday_text ---

    #[test]
    fn dday_종료전_남은일수를_표시한다() {
        let today = NaiveDate::from_ymd_opt(2026, 3, 17).unwrap();
        let status = DdayStatus::Active {
            end_date: NaiveDate::from_ymd_opt(2026, 3, 31).unwrap(),
        };
        assert_eq!(build_dday_text_for_date(&status, today), "수료까지 D-14");
    }

    #[test]
    fn dday_종료당일을_표시한다() {
        let today = NaiveDate::from_ymd_opt(2026, 3, 31).unwrap();
        let status = DdayStatus::Active {
            end_date: NaiveDate::from_ymd_opt(2026, 3, 31).unwrap(),
        };
        assert_eq!(build_dday_text_for_date(&status, today), "수료 D-Day");
    }

    #[test]
    fn dday_종료후에는_기본문구를_표시한다() {
        let today = NaiveDate::from_ymd_opt(2026, 4, 1).unwrap();
        let status = DdayStatus::Active {
            end_date: NaiveDate::from_ymd_opt(2026, 3, 31).unwrap(),
        };
        assert_eq!(build_dday_text_for_date(&status, today), "진행 중인 코스 없음");
    }

    #[test]
    fn dday_로그인필요를_표시한다() {
        let today = NaiveDate::from_ymd_opt(2026, 3, 17).unwrap();
        assert_eq!(
            build_dday_text_for_date(&DdayStatus::LoginRequired, today),
            "로그인 후 D-day 표시"
        );
    }

    #[test]
    fn dday_코호트없음을_표시한다() {
        let today = NaiveDate::from_ymd_opt(2026, 3, 17).unwrap();
        assert_eq!(
            build_dday_text_for_date(&DdayStatus::NoCohort, today),
            "진행 중인 코스 없음"
        );
    }

    #[test]
    fn dday_로딩중을_표시한다() {
        let today = NaiveDate::from_ymd_opt(2026, 3, 17).unwrap();
        assert_eq!(
            build_dday_text_for_date(&DdayStatus::Unknown, today),
            "D-day 확인 중..."
        );
    }

    // --- build_tooltip ---

    #[test]
    fn 툴팁은_상태문구를_감싼다() {
        assert_eq!(build_tooltip("오늘 출석 완료"), "Jungle Bell - 오늘 출석 완료");
    }

    #[test]
    fn 트레이_패널_액션은_허용된_값만_역직렬화한다() {
        let action: TrayPanelAction = serde_json::from_str("\"open_laundry\"").unwrap();
        assert_eq!(action, TrayPanelAction::OpenLaundry);
        assert!(serde_json::from_str::<TrayPanelAction>("\"open_shell\"").is_err());
    }

    #[test]
    fn 상단_트레이_패널은_아이콘_아래_중앙에_배치한다() {
        let position = calculate_panel_position(
            PanelRect {
                x: 900,
                y: 0,
                width: 24,
                height: 24,
            },
            PanelSize {
                width: 380,
                height: 620,
            },
            PanelRect {
                x: 0,
                y: 24,
                width: 1920,
                height: 1056,
            },
            8,
        );

        assert_eq!(position, PanelPosition { x: 722, y: 32 });
    }

    #[test]
    fn 하단_트레이_패널은_아이콘_위에_열리고_화면_우측을_넘지_않는다() {
        let position = calculate_panel_position(
            PanelRect {
                x: 1840,
                y: 1040,
                width: 24,
                height: 40,
            },
            PanelSize {
                width: 380,
                height: 620,
            },
            PanelRect {
                x: 0,
                y: 0,
                width: 1920,
                height: 1040,
            },
            8,
        );

        assert_eq!(position, PanelPosition { x: 1532, y: 412 });
    }

    fn mixed_scale_monitors() -> [MonitorGeometry; 2] {
        [
            MonitorGeometry {
                bounds: PanelRect {
                    x: 0,
                    y: 0,
                    width: 3024,
                    height: 1964,
                },
            },
            MonitorGeometry {
                bounds: PanelRect {
                    x: 3024,
                    y: 0,
                    width: 1920,
                    height: 1080,
                },
            },
        ]
    }

    #[test]
    fn 혼합배율에서_외장모니터의_트레이를_선택한다() {
        let monitors = mixed_scale_monitors();
        let selected = select_tray_monitor_index(
            &monitors,
            PanelPosition { x: 3412, y: 12 },
            PanelRect {
                x: 3400,
                y: 0,
                width: 24,
                height: 24,
            },
        );

        assert_eq!(selected, Some(1));
    }

    #[test]
    fn 혼합배율에서_내장모니터의_트레이를_선택한다() {
        let monitors = mixed_scale_monitors();
        let selected = select_tray_monitor_index(
            &monitors,
            PanelPosition { x: 2004, y: 24 },
            PanelRect {
                x: 1980,
                y: 0,
                width: 48,
                height: 48,
            },
        );

        assert_eq!(selected, Some(0));
    }

    #[test]
    fn 패널_물리크기는_대상모니터_배율을_따른다() {
        assert_eq!(
            panel_size_for_scale(1.0),
            PanelSize {
                width: 390,
                height: 640,
            }
        );
        assert_eq!(
            panel_size_for_scale(2.0),
            PanelSize {
                width: 780,
                height: 1280,
            }
        );
    }
}
