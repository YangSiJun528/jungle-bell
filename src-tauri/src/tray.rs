//! 시스템 트레이 모듈 — 아이콘, 메뉴, 툴팁, 메뉴 이벤트 처리.
//!
//! 트레이 아이콘은 현재 상태에 따라 색상이 변경됨:
//!   - 회색 (오프라인/확인 중): checker 미보고, 복구 중, 확인 불가
//!   - 검정/흰색 (조작 불필요): Idle, Studying, Complete
//!   - 오렌지 (경고): 로그인 필요
//!   - 빨간색 (긴급): NeedStart, StartOverdue, NeedEnd

use std::sync::{Arc, Mutex as StdMutex, MutexGuard as StdMutexGuard};
use std::time::Duration;
use tokio::sync::Mutex as TokioMutex;

use chrono::{DateTime, NaiveDate, Utc};
use serde::Serialize;

use crate::state::{AppState, CheckerRuntimeStatus, CohortPeriod, DailyPhase, DdayStatus, TraySnapshot};
use tauri::{
    image::Image,
    menu::MenuBuilder,
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WebviewWindow,
};

const STATUS_COURSE_UPCOMING: &str = "코스 시작 전";
const STATUS_COURSE_COMPLETE: &str = "코스 완료";
const STATUS_NO_COHORT: &str = "진행 중인 코스 없음";
const STATUS_NO_ATTENDANCE: &str = "현재 출석 없음";
const STATUS_COURSE_CHECKING: &str = "코스 확인 중";

const DASHBOARD_WINDOW_WIDTH: f64 = 1180.0;
const DASHBOARD_WINDOW_HEIGHT: f64 = 780.0;
const DASHBOARD_WINDOW_MIN_WIDTH: f64 = 760.0;
const DASHBOARD_WINDOW_MIN_HEIGHT: f64 = 560.0;

// 트레이 아이콘 — 컴파일 시 include_bytes!로 바이너리에 포함.
// macOS는 tray-icon이 강제하는 18pt의 정확한 @2x인 36px, 그 외 플랫폼은
// Windows 고배율 트레이에도 대응하는 48px 자산을 사용한다.
// 밝은 OS 배경에는 짙은 상태색, 어두운 OS 배경에는 밝은 상태색을 사용한다.
#[cfg(target_os = "macos")]
const ICON_OFFLINE_LIGHT: &[u8] = include_bytes!("../icons/tray-offline-light.png");
#[cfg(not(target_os = "macos"))]
const ICON_OFFLINE_LIGHT: &[u8] = include_bytes!("../icons/tray-offline-light-windows.png");
#[cfg(target_os = "macos")]
const ICON_NORMAL_LIGHT: &[u8] = include_bytes!("../icons/tray-normal-light.png");
#[cfg(not(target_os = "macos"))]
const ICON_NORMAL_LIGHT: &[u8] = include_bytes!("../icons/tray-normal-light-windows.png");
#[cfg(target_os = "macos")]
const ICON_WARNING_LIGHT: &[u8] = include_bytes!("../icons/tray-warning-light.png");
#[cfg(not(target_os = "macos"))]
const ICON_WARNING_LIGHT: &[u8] = include_bytes!("../icons/tray-warning-light-windows.png");
#[cfg(target_os = "macos")]
const ICON_ALERT_LIGHT: &[u8] = include_bytes!("../icons/tray-alert-light.png");
#[cfg(not(target_os = "macos"))]
const ICON_ALERT_LIGHT: &[u8] = include_bytes!("../icons/tray-alert-light-windows.png");
#[cfg(target_os = "macos")]
const ICON_COMPLETE_LIGHT: &[u8] = include_bytes!("../icons/tray-complete-light.png");
#[cfg(not(target_os = "macos"))]
const ICON_COMPLETE_LIGHT: &[u8] = include_bytes!("../icons/tray-complete-light-windows.png");
#[cfg(target_os = "macos")]
const ICON_OFFLINE_DARK: &[u8] = include_bytes!("../icons/tray-offline-dark.png");
#[cfg(not(target_os = "macos"))]
const ICON_OFFLINE_DARK: &[u8] = include_bytes!("../icons/tray-offline-dark-windows.png");
#[cfg(target_os = "macos")]
const ICON_NORMAL_DARK: &[u8] = include_bytes!("../icons/tray-normal-dark.png");
#[cfg(not(target_os = "macos"))]
const ICON_NORMAL_DARK: &[u8] = include_bytes!("../icons/tray-normal-dark-windows.png");
#[cfg(target_os = "macos")]
const ICON_WARNING_DARK: &[u8] = include_bytes!("../icons/tray-warning-dark.png");
#[cfg(not(target_os = "macos"))]
const ICON_WARNING_DARK: &[u8] = include_bytes!("../icons/tray-warning-dark-windows.png");
#[cfg(target_os = "macos")]
const ICON_ALERT_DARK: &[u8] = include_bytes!("../icons/tray-alert-dark.png");
#[cfg(not(target_os = "macos"))]
const ICON_ALERT_DARK: &[u8] = include_bytes!("../icons/tray-alert-dark-windows.png");
#[cfg(target_os = "macos")]
const ICON_COMPLETE_DARK: &[u8] = include_bytes!("../icons/tray-complete-dark.png");
#[cfg(not(target_os = "macos"))]
const ICON_COMPLETE_DARK: &[u8] = include_bytes!("../icons/tray-complete-dark-windows.png");

const TRAY_MENU_OPEN_ID: &str = "open-dashboard";
const TRAY_MENU_QUIT_ID: &str = "quit";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DashboardRoute {
    Home,
    Attendance,
    Laundry,
    Meals,
    Notifications,
}

impl DashboardRoute {
    fn as_str(self) -> &'static str {
        match self {
            Self::Home => "home",
            Self::Attendance => "attendance",
            Self::Laundry => "laundry",
            Self::Meals => "meals",
            Self::Notifications => "notifications",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TrayMenuAction {
    OpenDashboard,
    Quit,
}

fn tray_menu_action(id: &str) -> Option<TrayMenuAction> {
    match id {
        TRAY_MENU_OPEN_ID => Some(TrayMenuAction::OpenDashboard),
        TRAY_MENU_QUIT_ID => Some(TrayMenuAction::Quit),
        _ => None,
    }
}

fn tray_click_opens_dashboard(button: MouseButton, state: MouseButtonState) -> bool {
    button == MouseButton::Left && state == MouseButtonState::Up
}

/// 트레이 아이콘과 툴팁의 로컬 표시 상태를 보관한다.
pub struct TrayState {
    view: TrayViewModel,
    icon_theme: TrayIconTheme,
}

/// 짧은 메모리 표시 상태 갱신을 유실 없이 직렬화한다.
///
/// 비동기 작업이나 파일 I/O를 잠금 안에서 수행하지 않으므로 일반 mutex가
/// `try_lock` 기반 best-effort 갱신보다 이 상태의 성격에 맞다.
pub struct TrayStateStore {
    state: StdMutex<TrayState>,
    icon_update: StdMutex<()>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TrayIconKind {
    Offline,
    Normal,
    Warning,
    Alert,
    Complete,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TrayIconTheme {
    Light,
    Dark,
}

impl From<tauri::Theme> for TrayIconTheme {
    fn from(theme: tauri::Theme) -> Self {
        match theme {
            tauri::Theme::Dark => Self::Dark,
            tauri::Theme::Light => Self::Light,
            _ => Self::Light,
        }
    }
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
    dday_period: Option<CohortPeriod>,
    tooltip: String,
}

fn icon_bytes_for_kind(kind: TrayIconKind, theme: TrayIconTheme) -> &'static [u8] {
    match (theme, kind) {
        (TrayIconTheme::Light, TrayIconKind::Offline) => ICON_OFFLINE_LIGHT,
        (TrayIconTheme::Light, TrayIconKind::Normal) => ICON_NORMAL_LIGHT,
        (TrayIconTheme::Light, TrayIconKind::Warning) => ICON_WARNING_LIGHT,
        (TrayIconTheme::Light, TrayIconKind::Alert) => ICON_ALERT_LIGHT,
        (TrayIconTheme::Light, TrayIconKind::Complete) => ICON_COMPLETE_LIGHT,
        (TrayIconTheme::Dark, TrayIconKind::Offline) => ICON_OFFLINE_DARK,
        (TrayIconTheme::Dark, TrayIconKind::Normal) => ICON_NORMAL_DARK,
        (TrayIconTheme::Dark, TrayIconKind::Warning) => ICON_WARNING_DARK,
        (TrayIconTheme::Dark, TrayIconKind::Alert) => ICON_ALERT_DARK,
        (TrayIconTheme::Dark, TrayIconKind::Complete) => ICON_COMPLETE_DARK,
    }
}

fn icon_for_kind(kind: TrayIconKind, theme: TrayIconTheme) -> Image<'static> {
    Image::from_bytes(icon_bytes_for_kind(kind, theme)).expect("invalid icon PNG")
}

fn apply_tray_icon(app: &tauri::AppHandle, kind: TrayIconKind, theme: TrayIconTheme) -> Result<(), String> {
    if let Some(tray) = app.tray_by_id("main-tray") {
        tray.set_icon_with_as_template(Some(icon_for_kind(kind, theme)), false)
            .map_err(|error| format!("트레이 아이콘 적용 실패: {error}"))?;
    };
    Ok(())
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
        DailyPhase::Complete => TrayIconKind::Complete,
        DailyPhase::Idle | DailyPhase::Studying => TrayIconKind::Normal,
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
        CheckerRuntimeStatus::Healthy { .. } => STATUS_NO_ATTENDANCE,
    }
}

/// 출석 phase 기준 상태 텍스트 생성.
fn build_attendance_status_text(phase: DailyPhase, remaining: Option<i64>, needs_login: bool) -> String {
    if needs_login {
        return "⚠️ 로그인 필요".to_string();
    }

    let mins = remaining.map(|s| (s + 59) / 60);

    /// 분 단위 잔여시간을 "X시간 Y분" 또는 "X분" 형식으로 포매팅.
    fn fmt_time(m: i64) -> String {
        let hours = m / 60;
        let rest = m % 60;
        if hours > 0 {
            format!("{}시간 {}분", hours, rest)
        } else {
            format!("{}분", m)
        }
    }

    match phase {
        DailyPhase::Idle => STATUS_NO_ATTENDANCE.to_string(),
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

/// 트레이 툴팁의 로컬 출석 상태 텍스트 생성.
fn build_status_text(snapshot: &TraySnapshot) -> String {
    if snapshot.checker_status.is_recovering_or_offline() {
        return checker_status_text(snapshot.checker_status).to_string();
    }

    if !snapshot.data_loaded {
        return "상태 확인 중...".to_string();
    }

    match &snapshot.dday_status {
        DdayStatus::Upcoming { .. } => return STATUS_COURSE_UPCOMING.to_string(),
        DdayStatus::Ended => return STATUS_COURSE_COMPLETE.to_string(),
        DdayStatus::NoCohort => return STATUS_NO_COHORT.to_string(),
        DdayStatus::Unknown if snapshot.phase == DailyPhase::Idle => {
            return STATUS_COURSE_CHECKING.to_string();
        }
        DdayStatus::Unknown => {}
        DdayStatus::Active { .. } | DdayStatus::Unavailable | DdayStatus::LoginRequired => {}
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
        DdayStatus::Unavailable | DdayStatus::Upcoming { end_date: None } => "수료일 정보 없음".to_string(),
        DdayStatus::Ended => STATUS_COURSE_COMPLETE.to_string(),
        DdayStatus::NoCohort => STATUS_NO_COHORT.to_string(),
        DdayStatus::Active { end_date }
        | DdayStatus::Upcoming {
            end_date: Some(end_date),
        } => {
            let days = end_date.signed_duration_since(today).num_days();
            if days > 0 {
                format!("수료까지 D-{}", days)
            } else if days == 0 {
                "수료 D-Day".to_string()
            } else {
                STATUS_COURSE_COMPLETE.to_string()
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
        dday_period: snapshot.cohort_period,
        tooltip: build_tooltip(&status_text),
        status_text,
    }
}

impl TrayStateStore {
    fn new(state: TrayState) -> Self {
        Self {
            state: StdMutex::new(state),
            icon_update: StdMutex::new(()),
        }
    }

    fn lock(&self) -> Result<StdMutexGuard<'_, TrayState>, String> {
        self.state
            .lock()
            .map_err(|_| "트레이 상태 잠금이 손상되었습니다.".to_string())
    }

    fn set_view(&self, view: TrayViewModel) -> Result<(), String> {
        let mut state = self.lock()?;
        state.view = view;
        Ok(())
    }

    fn set_icon_theme(&self, icon_theme: TrayIconTheme) -> Result<bool, String> {
        let mut state = self.lock()?;
        if state.icon_theme == icon_theme {
            return Ok(false);
        }
        state.icon_theme = icon_theme;
        Ok(true)
    }

    fn icon_projection(&self) -> Result<(TrayIconKind, TrayIconTheme), String> {
        let state = self.lock()?;
        Ok((state.view.icon, state.icon_theme))
    }

    fn apply_current_icon(&self, app: &tauri::AppHandle) -> Result<(), String> {
        let _update_guard = self
            .icon_update
            .lock()
            .map_err(|_| "트레이 아이콘 갱신 잠금이 손상되었습니다.".to_string())?;
        let (kind, theme) = self.icon_projection()?;
        apply_tray_icon(app, kind, theme)
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
    crate::notification_inbox::sync_badge_for_window(window);

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

fn foreground_window_skip_taskbar(_app: &tauri::AppHandle) -> bool {
    false
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
    set_macos_foreground_visibility(app, true);

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

fn dashboard_app_url(route: DashboardRoute) -> String {
    format!("dashboard.html#{}", route.as_str())
}

fn select_dashboard_route(window: &WebviewWindow<tauri::Wry>, route: DashboardRoute) {
    // route는 닫힌 Rust enum이므로 JS 문자열에 외부 입력이 들어가지 않는다.
    let script = match route {
        DashboardRoute::Home => "window.location.hash = '#home'",
        DashboardRoute::Attendance => "window.location.hash = '#attendance'",
        DashboardRoute::Laundry => "window.location.hash = '#laundry'",
        DashboardRoute::Meals => "window.location.hash = '#meals'",
        DashboardRoute::Notifications => "window.location.hash = '#notifications'",
    };
    if let Err(error) = window.eval(script) {
        log::warn!("[dashboard] route selection failed: {error}");
    }
}

fn build_dashboard_window(app: &tauri::AppHandle, route: DashboardRoute) {
    show_foreground_app(app);
    match tauri::WebviewWindowBuilder::new(
        app,
        "dashboard",
        tauri::WebviewUrl::App(dashboard_app_url(route).into()),
    )
    .title("Jungle Bell")
    .theme(Some(tauri::Theme::Light))
    .inner_size(DASHBOARD_WINDOW_WIDTH, DASHBOARD_WINDOW_HEIGHT)
    .min_inner_size(DASHBOARD_WINDOW_MIN_WIDTH, DASHBOARD_WINDOW_MIN_HEIGHT)
    .resizable(true)
    .minimizable(true)
    .maximizable(true)
    .skip_taskbar(foreground_window_skip_taskbar(app))
    .focused(true)
    .build()
    {
        Ok(window) => {
            focus_window(&window);
            let app_handle = app.clone();
            let window_for_event = window.clone();
            window.on_window_event(move |event| match event {
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    if let Err(error) = window_for_event.hide() {
                        log::warn!("[dashboard] hide on close failed: {error}");
                    }
                    sync_foreground_app_visibility_soon(app_handle.clone());
                }
                tauri::WindowEvent::Destroyed => {
                    sync_foreground_app_visibility_soon(app_handle.clone());
                }
                _ => {}
            });
        }
        Err(error) => log::error!("[dashboard] window creation failed: {error}"),
    }
}

pub fn open_dashboard_window(app: &tauri::AppHandle) {
    open_dashboard_route_now(app, DashboardRoute::Home);
}

fn open_dashboard_route_now(app: &tauri::AppHandle, route: DashboardRoute) {
    log::info!("[dashboard] route opened: {}", route.as_str());
    if let Some(window) = app.get_webview_window("dashboard") {
        show_foreground_app(app);
        select_dashboard_route(&window, route);
        focus_window(&window);
    } else {
        build_dashboard_window(app, route);
    }
}

pub(crate) fn open_dashboard_route(app: &tauri::AppHandle, route: DashboardRoute) -> Result<(), String> {
    run_window_task(app, move |app| open_dashboard_route_now(&app, route))
}

fn run_window_task<F>(app: &tauri::AppHandle, task: F) -> Result<(), String>
where
    F: FnOnce(tauri::AppHandle) + Send + 'static,
{
    let app_handle = app.clone();
    app.run_on_main_thread(move || task(app_handle))
        .map_err(|error| format!("창 작업 예약 실패: {error}"))
}

/// 시스템 트레이 생성: 상태 아이콘, 대시보드 열기, 종료를 설정한다.
pub fn setup_tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let initial_view = {
        let state: tauri::State<Arc<TokioMutex<AppState>>> = app.state();
        let state = state.try_lock().map_err(|_| "초기 앱 상태 잠금 실패")?;
        build_tray_view_model(&state.tray_snapshot(None), Utc::now())
    };

    let tray_state = TrayStateStore::new(TrayState {
        view: initial_view.clone(),
        icon_theme: TrayIconTheme::Light,
    });
    app.manage(tray_state);

    let tray_menu = MenuBuilder::new(app)
        .text(TRAY_MENU_OPEN_ID, "대시보드 열기")
        .separator()
        .text(TRAY_MENU_QUIT_ID, "종료")
        .build()?;

    let _tray = TrayIconBuilder::with_id("main-tray")
        .icon(icon_for_kind(initial_view.icon, TrayIconTheme::Light))
        .icon_as_template(false)
        .tooltip("Jungle Bell - 상태 확인 중...")
        .menu(&tray_menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match tray_menu_action(event.id().as_ref()) {
            Some(TrayMenuAction::OpenDashboard) => open_dashboard_window(app),
            Some(TrayMenuAction::Quit) => app.exit(0),
            None => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button, button_state, ..
            } = event
            {
                if tray_click_opens_dashboard(button, button_state) {
                    open_dashboard_window(tray.app_handle());
                }
            }
        })
        .build(app)?;

    Ok(())
}

/// 시스템 테마 변경을 현재 트레이 상태 아이콘에 즉시 반영한다.
pub fn sync_icon_theme(app: &tauri::AppHandle, system_theme: tauri::Theme) -> Result<(), String> {
    let icon_theme = TrayIconTheme::from(system_theme);
    let tray_state: tauri::State<TrayStateStore> = app.state();
    if !tray_state.set_icon_theme(icon_theme)? {
        return Ok(());
    }

    tray_state.apply_current_icon(app)?;
    log::info!("[tray] icon theme changed: {icon_theme:?}");
    Ok(())
}

/// 트레이 아이콘과 툴팁의 로컬 표시 상태를 갱신한다.
/// 스케줄러(주기적)와 체커(보고 시) 양쪽에서 호출됨.
pub fn update_tray(app: &tauri::AppHandle, snapshot: &TraySnapshot) -> Result<(), String> {
    let view = build_tray_view_model(snapshot, Utc::now());
    let tray_state: tauri::State<TrayStateStore> = app.state();
    tray_state.set_view(view.clone())?;

    if let Err(error) = tray_state.apply_current_icon(app) {
        log::warn!("[tray] icon update failed: {error}");
    }
    if let Some(tray) = app.tray_by_id("main-tray") {
        if let Err(error) = tray.set_tooltip(Some(&view.tooltip)) {
            log::warn!("[tray] tooltip update failed: {error}");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "macos")]
    const EXPECTED_TRAY_ICON_SIZE: u32 = 36;
    #[cfg(not(target_os = "macos"))]
    const EXPECTED_TRAY_ICON_SIZE: u32 = 48;

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
            cohort_period: None,
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

    fn rgba_at(image: &Image<'_>, x: u32, y: u32) -> [u8; 4] {
        assert!(x < image.width());
        assert!(y < image.height());
        let offset = ((y * image.width() + x) * 4) as usize;
        image.rgba()[offset..offset + 4].try_into().unwrap()
    }

    fn has_antialiased_edge(image: &Image<'_>) -> bool {
        image
            .rgba()
            .chunks_exact(4)
            .any(|pixel| pixel[3] > 0 && pixel[3] < u8::MAX)
    }

    fn visible_bounds(image: &Image<'_>) -> (u32, u32, u32, u32) {
        let mut bounds: Option<(u32, u32, u32, u32)> = None;

        for y in 0..image.height() {
            for x in 0..image.width() {
                if rgba_at(image, x, y)[3] < 128 {
                    continue;
                }

                bounds = Some(match bounds {
                    Some((min_x, min_y, max_x, max_y)) => (min_x.min(x), min_y.min(y), max_x.max(x), max_y.max(y)),
                    None => (x, y, x, y),
                });
            }
        }

        bounds.expect("visible tray icon artwork is missing")
    }

    fn visible_pixel_ratio(image: &Image<'_>) -> f64 {
        let visible = image.rgba().chunks_exact(4).filter(|pixel| pixel[3] >= 128).count();
        visible as f64 / (image.width() * image.height()) as f64
    }

    fn contains_opaque_color(image: &Image<'_>, expected: [u8; 3]) -> bool {
        image
            .rgba()
            .chunks_exact(4)
            .any(|pixel| pixel[0..3] == expected && pixel[3] == u8::MAX)
    }

    #[test]
    fn 라이트_테마는_모든_상태에서_라이트용_아이콘을_선택한다() {
        assert_eq!(
            icon_bytes_for_kind(TrayIconKind::Offline, TrayIconTheme::Light),
            ICON_OFFLINE_LIGHT
        );
        assert_eq!(
            icon_bytes_for_kind(TrayIconKind::Normal, TrayIconTheme::Light),
            ICON_NORMAL_LIGHT
        );
        assert_eq!(
            icon_bytes_for_kind(TrayIconKind::Warning, TrayIconTheme::Light),
            ICON_WARNING_LIGHT
        );
        assert_eq!(
            icon_bytes_for_kind(TrayIconKind::Alert, TrayIconTheme::Light),
            ICON_ALERT_LIGHT
        );
        assert_eq!(
            icon_bytes_for_kind(TrayIconKind::Complete, TrayIconTheme::Light),
            ICON_COMPLETE_LIGHT
        );
    }

    #[test]
    fn 다크_테마는_모든_상태에서_다크용_아이콘을_선택한다() {
        assert_eq!(
            icon_bytes_for_kind(TrayIconKind::Offline, TrayIconTheme::Dark),
            ICON_OFFLINE_DARK
        );
        assert_eq!(
            icon_bytes_for_kind(TrayIconKind::Normal, TrayIconTheme::Dark),
            ICON_NORMAL_DARK
        );
        assert_eq!(
            icon_bytes_for_kind(TrayIconKind::Warning, TrayIconTheme::Dark),
            ICON_WARNING_DARK
        );
        assert_eq!(
            icon_bytes_for_kind(TrayIconKind::Alert, TrayIconTheme::Dark),
            ICON_ALERT_DARK
        );
        assert_eq!(
            icon_bytes_for_kind(TrayIconKind::Complete, TrayIconTheme::Dark),
            ICON_COMPLETE_DARK
        );
    }

    #[test]
    fn 트레이_아이콘은_나침반_바깥과_배경_박스_사이를_상태색으로_채운다() {
        let light = icon_for_kind(TrayIconKind::Alert, TrayIconTheme::Light);
        let dark = icon_for_kind(TrayIconKind::Alert, TrayIconTheme::Dark);

        assert_eq!(
            (light.width(), light.height()),
            (EXPECTED_TRAY_ICON_SIZE, EXPECTED_TRAY_ICON_SIZE)
        );
        assert_eq!(
            (dark.width(), dark.height()),
            (EXPECTED_TRAY_ICON_SIZE, EXPECTED_TRAY_ICON_SIZE)
        );
        for image in [&light, &dark] {
            assert!(rgba_at(image, 0, 0)[3] < 16);
            assert!(rgba_at(image, image.width() - 1, 0)[3] < 16);
            assert!(rgba_at(image, 0, image.height() - 1)[3] < 16);
            assert!(rgba_at(image, image.width() - 1, image.height() - 1)[3] < 16);
            assert!(rgba_at(image, image.width() * 5 / 44, image.height() / 2)[3] > 240);
            assert!(rgba_at(image, image.width() * 15 / 44, image.height() / 2)[3] < 32);
            assert!(rgba_at(image, image.width() / 2, image.height() / 2)[3] > 240);
            assert!(visible_pixel_ratio(image) > 0.30);
            assert!(visible_pixel_ratio(image) < 0.60);
            assert!(has_antialiased_edge(image));

            let (min_x, min_y, max_x, max_y) = visible_bounds(image);
            assert_eq!(min_x + max_x, image.width() - 1);
            assert_eq!(min_y + max_y, image.height() - 1);
        }

        assert!(contains_opaque_color(&light, [180, 35, 44]));
        assert!(contains_opaque_color(&dark, [240, 93, 101]));
    }

    #[test]
    fn 트레이_svg는_원본_나침반_바깥과_배경_박스_사이만_채운다() {
        let svg = include_str!("../icons/tray-source.svg");

        assert!(svg.contains("viewBox=\"0 0 44 44\""));
        assert!(svg.contains("<mask id=\"compass-field\""));
        assert!(svg.contains("<rect x=\"3\" y=\"3\" width=\"38\" height=\"38\" rx=\"10\" fill=\"white\""));
        assert!(svg.contains("<circle cx=\"22\" cy=\"22\" r=\"16\" fill=\"black\""));
        assert!(svg.contains(
            "<rect x=\"3\" y=\"3\" width=\"38\" height=\"38\" rx=\"10\" fill=\"currentColor\" mask=\"url(#compass-field)\""
        ));
        assert!(svg.contains("<g fill=\"currentColor\" transform=\"translate(3.5 3.5) scale(.0361328125)\""));
        assert!(svg.contains("M512 896a384 384 0 1 0 0-768"));
        assert!(svg.contains("M725.888 315.008C676.48 428.672"));
    }

    #[test]
    fn 출석완료_아이콘은_테마별_무채색으로_표시한다() {
        let light = icon_for_kind(TrayIconKind::Complete, TrayIconTheme::Light);
        let dark = icon_for_kind(TrayIconKind::Complete, TrayIconTheme::Dark);
        let normal_light = icon_for_kind(TrayIconKind::Normal, TrayIconTheme::Light);
        let normal_dark = icon_for_kind(TrayIconKind::Normal, TrayIconTheme::Dark);

        assert_eq!(light.rgba(), normal_light.rgba());
        assert_eq!(dark.rgba(), normal_dark.rgba());
        assert!(contains_opaque_color(&light, [36, 49, 59]));
        assert!(contains_opaque_color(&dark, [238, 242, 243]));
        assert!(visible_pixel_ratio(&light) > 0.30);
        assert!(visible_pixel_ratio(&dark) > 0.30);
    }

    #[test]
    fn windows용_아이콘은_48픽셀_고해상도_자산을_사용한다() {
        let alert = Image::from_bytes(include_bytes!("../icons/tray-alert-light-windows.png")).unwrap();
        let normal_light = Image::from_bytes(include_bytes!("../icons/tray-normal-light-windows.png")).unwrap();
        let complete_light = Image::from_bytes(include_bytes!("../icons/tray-complete-light-windows.png")).unwrap();
        let normal_dark = Image::from_bytes(include_bytes!("../icons/tray-normal-dark-windows.png")).unwrap();
        let complete_dark = Image::from_bytes(include_bytes!("../icons/tray-complete-dark-windows.png")).unwrap();

        assert_eq!((alert.width(), alert.height()), (48, 48));
        assert_eq!((complete_dark.width(), complete_dark.height()), (48, 48));
        assert!(rgba_at(&alert, 0, 0)[3] < 16);
        assert!(rgba_at(&alert, alert.width() * 5 / 44, alert.height() / 2)[3] > 240);
        assert!(rgba_at(&alert, alert.width() * 15 / 44, alert.height() / 2)[3] < 32);
        assert!(rgba_at(&alert, alert.width() / 2, alert.height() / 2)[3] > 240);
        assert!(contains_opaque_color(&alert, [180, 35, 44]));
        assert!(visible_pixel_ratio(&alert) > 0.30);
        assert!(visible_pixel_ratio(&alert) < 0.60);
        assert_eq!(normal_light.rgba(), complete_light.rgba());
        assert_eq!(normal_dark.rgba(), complete_dark.rgba());
        assert!(contains_opaque_color(&complete_light, [36, 49, 59]));
        assert!(contains_opaque_color(&complete_dark, [238, 242, 243]));
    }

    #[test]
    fn 나침반_확대는_박스와의_거리를_절반_이상_줄이고_링을_과도하게_굵히지_않는다() {
        let original_scale = 28.0 / 1024.0;
        let enlarged_scale = 37.0 / 1024.0;
        let original_gap = 22.0 - 448.0 * original_scale - 3.0;
        let enlarged_gap = 22.0 - 448.0 * enlarged_scale - 3.0;
        let enlarged_ring_width = 64.0 * enlarged_scale;

        assert!(enlarged_gap < original_gap / 2.0);
        assert!(enlarged_ring_width <= 2.4);
    }

    #[test]
    fn 플랫폼별_아이콘의_곡선은_중간_알파로_안티앨리어싱된다() {
        let current_platform = icon_for_kind(TrayIconKind::Normal, TrayIconTheme::Light);
        let windows = Image::from_bytes(include_bytes!("../icons/tray-normal-light-windows.png")).unwrap();

        assert!(has_antialiased_edge(&current_platform));
        assert!(has_antialiased_edge(&windows));
    }

    #[test]
    fn 시스템_테마를_트레이_아이콘_테마로_변환한다() {
        assert_eq!(TrayIconTheme::from(tauri::Theme::Light), TrayIconTheme::Light);
        assert_eq!(TrayIconTheme::from(tauri::Theme::Dark), TrayIconTheme::Dark);
    }

    #[test]
    fn 테마_변경은_현재_상태_아이콘을_유지하고_중복_갱신을_생략한다() {
        let view = build_tray_view_model(&healthy_snapshot(DailyPhase::NeedStart, Some(1800), false), Utc::now());
        let store = TrayStateStore::new(TrayState {
            view,
            icon_theme: TrayIconTheme::Light,
        });

        assert!(store.set_icon_theme(TrayIconTheme::Dark).unwrap());
        assert_eq!(
            store.icon_projection().unwrap(),
            (TrayIconKind::Alert, TrayIconTheme::Dark)
        );
        assert!(!store.set_icon_theme(TrayIconTheme::Dark).unwrap());
    }

    #[test]
    fn 대시보드는_닫을때_숨기고_기존_창을_재사용한다() {
        let source = include_str!("tray.rs");
        assert!(source.contains("tauri::WindowEvent::CloseRequested { api, .. }"));
        assert!(source.contains("api.prevent_close()"));
        assert!(source.contains("window_for_event.hide()"));
        assert!(source.contains("if let Some(window) = app.get_webview_window(\"dashboard\")"));
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
    fn 확인이나_조작이_필요하지_않은_상태는_무채색_아이콘을_표시한다() {
        let idle = build_tray_view_model(&healthy_snapshot(DailyPhase::Idle, None, false), Utc::now());
        let studying = build_tray_view_model(&healthy_snapshot(DailyPhase::Studying, Some(14_580), false), Utc::now());
        let complete = build_tray_view_model(&healthy_snapshot(DailyPhase::Complete, None, false), Utc::now());

        assert_eq!(idle.icon, TrayIconKind::Normal);
        assert_eq!(studying.icon, TrayIconKind::Normal);
        assert_eq!(complete.icon, TrayIconKind::Complete);
        assert_eq!(studying.status_text, "학습 중 (종료 가능까지 4시간 3분)");

        for theme in [TrayIconTheme::Light, TrayIconTheme::Dark] {
            let normal = icon_for_kind(TrayIconKind::Normal, theme);
            let complete = icon_for_kind(TrayIconKind::Complete, theme);

            assert_eq!(normal.rgba(), complete.rgba());
            assert!(rgba_at(&normal, 0, 0)[3] < 16);
            assert!(visible_pixel_ratio(&normal) > 0.30);
            assert!(visible_pixel_ratio(&normal) < 0.60);
        }
    }

    #[test]
    fn 출석완료_상태를_표시한다() {
        let view = build_tray_view_model(&healthy_snapshot(DailyPhase::Complete, None, false), Utc::now());

        assert_eq!(view.icon, TrayIconKind::Complete);
        assert_eq!(view.status_text, "오늘 출석 완료");
    }

    #[test]
    fn 시작전_코스는_짧고_명시적으로_표시한다() {
        let mut snapshot = healthy_snapshot(DailyPhase::Idle, None, false);
        snapshot.dday_status = DdayStatus::Upcoming { end_date: None };

        let view = build_tray_view_model(&snapshot, Utc::now());

        assert_eq!(view.status_text, "코스 시작 전");
    }

    #[test]
    fn 완료된_코스는_짧고_명시적으로_표시한다() {
        let mut snapshot = healthy_snapshot(DailyPhase::Idle, None, false);
        snapshot.dday_status = DdayStatus::Ended;

        let view = build_tray_view_model(&snapshot, Utc::now());

        assert_eq!(view.status_text, "코스 완료");
    }

    #[test]
    fn 코호트가_없으면_짧고_명시적으로_표시한다() {
        let mut snapshot = healthy_snapshot(DailyPhase::Idle, None, false);
        snapshot.dday_status = DdayStatus::NoCohort;

        let view = build_tray_view_model(&snapshot, Utc::now());

        assert_eq!(view.status_text, "진행 중인 코스 없음");
    }

    #[test]
    fn 활성_코스의_idle은_현재_출석이_없다고_표시한다() {
        let mut snapshot = healthy_snapshot(DailyPhase::Idle, None, false);
        snapshot.dday_status = DdayStatus::Active {
            end_date: NaiveDate::from_ymd_opt(2026, 12, 31).unwrap(),
        };

        let view = build_tray_view_model(&snapshot, Utc::now());

        assert_eq!(view.status_text, "현재 출석 없음");
    }

    #[test]
    fn 코스_상태_판별중은_짧고_명시적으로_표시한다() {
        let snapshot = healthy_snapshot(DailyPhase::Idle, None, false);

        let view = build_tray_view_model(&snapshot, Utc::now());

        assert_eq!(view.status_text, "코스 확인 중");
    }

    #[test]
    fn 코스_상태_문구는_12자_이내다() {
        for text in [
            "코스 시작 전",
            "코스 완료",
            "진행 중인 코스 없음",
            "현재 출석 없음",
            "코스 확인 중",
        ] {
            assert!(text.chars().count() <= 12, "{text}");
        }
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
        assert_eq!(build_dday_text_for_date(&status, today), "코스 완료");
    }

    #[test]
    fn dday_완료된_코스를_표시한다() {
        let today = NaiveDate::from_ymd_opt(2026, 4, 1).unwrap();
        assert_eq!(build_dday_text_for_date(&DdayStatus::Ended, today), "코스 완료");
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

    #[test]
    fn dday_종료일_정보없음을_표시한다() {
        let today = NaiveDate::from_ymd_opt(2026, 3, 17).unwrap();
        assert_eq!(
            build_dday_text_for_date(&DdayStatus::Unavailable, today),
            "수료일 정보 없음"
        );
    }

    #[test]
    fn dday_시작전_기수의_수료일까지_표시한다() {
        let today = NaiveDate::from_ymd_opt(2026, 7, 27).unwrap();
        let status = DdayStatus::Upcoming {
            end_date: Some(NaiveDate::from_ymd_opt(2026, 12, 31).unwrap()),
        };
        assert_eq!(build_dday_text_for_date(&status, today), "수료까지 D-157");
    }

    // --- build_tooltip ---

    #[test]
    fn 툴팁은_상태문구를_감싼다() {
        assert_eq!(build_tooltip("오늘 출석 완료"), "Jungle Bell - 오늘 출석 완료");
    }

    #[test]
    fn 트레이_왼쪽_클릭_up만_대시보드_홈을_연다() {
        assert!(tray_click_opens_dashboard(MouseButton::Left, MouseButtonState::Up));
        assert!(!tray_click_opens_dashboard(MouseButton::Right, MouseButtonState::Up));
        assert!(!tray_click_opens_dashboard(MouseButton::Middle, MouseButtonState::Up));
        assert!(!tray_click_opens_dashboard(MouseButton::Left, MouseButtonState::Down));
        assert!(!tray_click_opens_dashboard(MouseButton::Right, MouseButtonState::Down));
    }

    #[test]
    fn 네이티브_트레이_메뉴는_대시보드_열기와_종료만_제공한다() {
        assert_eq!(tray_menu_action(TRAY_MENU_OPEN_ID), Some(TrayMenuAction::OpenDashboard));
        assert_eq!(tray_menu_action(TRAY_MENU_QUIT_ID), Some(TrayMenuAction::Quit));
        assert_eq!(tray_menu_action("unknown"), None);
    }

    #[test]
    fn 대시보드_홈과_알림_이동은_고정된_hash_route를_사용한다() {
        assert_eq!(dashboard_app_url(DashboardRoute::Home), "dashboard.html#home");
        assert_eq!(
            dashboard_app_url(DashboardRoute::Attendance),
            "dashboard.html#attendance"
        );
        assert_eq!(dashboard_app_url(DashboardRoute::Laundry), "dashboard.html#laundry");
        assert_eq!(dashboard_app_url(DashboardRoute::Meals), "dashboard.html#meals");
        assert_eq!(
            dashboard_app_url(DashboardRoute::Notifications),
            "dashboard.html#notifications"
        );
    }

    #[test]
    fn 트레이_패널_webview는_생성하지_않는다() {
        let source = include_str!("tray.rs");
        let removed_label = ["tray", "panel"].join("-");
        let removed_toggle = ["toggle", "tray", "panel"].join("_");
        assert!(!source.contains(&format!("\"{removed_label}\"")));
        assert!(!source.contains(&format!("{removed_label}.html")));
        assert!(!source.contains(&removed_toggle));
        assert!(source.contains("open_dashboard_window(tray.app_handle())"));
        assert!(source.contains(".show_menu_on_left_click(false)"));
        assert!(source.contains(".menu(&tray_menu)"));
    }

    #[test]
    fn tray_state_store_waits_for_contention_and_keeps_the_latest_update() {
        use std::sync::mpsc;
        use std::time::Duration;

        let initial_view = build_tray_view_model(&healthy_snapshot(DailyPhase::Studying, None, false), Utc::now());
        let store = Arc::new(TrayStateStore::new(TrayState {
            view: initial_view,
            icon_theme: TrayIconTheme::Light,
        }));
        let held_guard = store.state.lock().unwrap();
        let (started_tx, started_rx) = mpsc::channel();
        let (finished_tx, finished_rx) = mpsc::channel();
        let worker_store = store.clone();
        let updated_view = build_tray_view_model(&healthy_snapshot(DailyPhase::Complete, None, false), Utc::now());

        let worker = std::thread::spawn(move || {
            started_tx.send(()).unwrap();
            finished_tx.send(worker_store.set_view(updated_view)).unwrap();
        });

        started_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        assert!(
            finished_rx.recv_timeout(Duration::from_millis(20)).is_err(),
            "경합 중인 갱신은 유실되지 않고 잠금 해제를 기다려야 한다"
        );
        drop(held_guard);

        finished_rx.recv_timeout(Duration::from_secs(1)).unwrap().unwrap();
        worker.join().unwrap();
        assert_eq!(store.lock().unwrap().view.status, TrayStatusKind::Complete);
    }
}
