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

use crate::state::{AppState, CheckerRuntimeStatus, DailyPhase, DdayStatus, TraySnapshot};
use tauri::{
    image::Image,
    menu::{Menu, MenuBuilder, MenuItem, MenuItemBuilder},
    tray::TrayIconBuilder,
    Manager, WebviewWindow,
};

const ATTENDANCE_URL: &str = "https://jungle-lms.krafton.com/check-in";
const MEAL_PLAN_URL: &str = "https://pf.kakao.com/_xhzNjn/posts";
const FEEDBACK_URL: &str = "https://github.com/YangSiJun528/jungle-bell/issues/new/choose";

/// 출석 페이지 닫힌 후 로그인 재시도 윈도우 (초). 3분간 빠르게 재확인.
const LOGIN_RETRY_WINDOW_SECS: u64 = 180;

/// 트레이 메뉴 최소 가로 폭(문자 수). 상태 아이템 텍스트에 non-breaking space로
/// 패딩을 채워 메뉴 전체 폭을 보장한다.
const TRAY_STATUS_MIN_WIDTH: usize = 26;
const DDAY_MENU_POSITION: usize = 1;

// 트레이 아이콘 — 컴파일 시 include_bytes!로 바이너리에 포함
const ICON_OFFLINE: &[u8] = include_bytes!("../icons/tray-gray.png");
const ICON_NORMAL: &[u8] = include_bytes!("../icons/tray-white.png");
const ICON_ALERT: &[u8] = include_bytes!("../icons/tray-red.png");
const ICON_WARNING: &[u8] = include_bytes!("../icons/tray-orange.png");

#[cfg(target_os = "macos")]
const FOREGROUND_WINDOW_LABELS: [&str; 4] = ["attendance", "settings", "onboarding", "meal_plan"];

/// 상태 메뉴 아이템 참조 보관용. 텍스트 동적 갱신에 사용.
/// Tauri managed state로 저장: `Arc<TokioMutex<TrayState>>`.
pub struct TrayState {
    pub menu: Menu<tauri::Wry>,
    pub status_item: MenuItem<tauri::Wry>,
    pub dday_item: MenuItem<tauri::Wry>,
    pub version_item: MenuItem<tauri::Wry>,
    pub dday_visible: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TrayIconKind {
    Offline,
    Normal,
    Warning,
    Alert,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TrayViewModel {
    icon: TrayIconKind,
    status_text: String,
    dday_text: String,
    tooltip: String,
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

fn checker_status_text(status: CheckerRuntimeStatus) -> &'static str {
    match status {
        CheckerRuntimeStatus::Loading
        | CheckerRuntimeStatus::PageLoaded { .. }
        | CheckerRuntimeStatus::Ready { .. } => "상태 확인 중...",
        CheckerRuntimeStatus::Recreating { .. } => "상태 재확인 중...",
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

/// 트레이 메뉴에 표시할 상태 텍스트 생성.
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
        icon: icon_kind_for_snapshot(snapshot),
        dday_text: build_dday_text(&snapshot.dday_status, now),
        tooltip: build_tooltip(&status_text),
        status_text,
    }
}

/// 문자열 뒤에 non-breaking space(U+00A0)를 채워 최소 폭을 보장.
/// 일반 공백은 macOS NSMenu 등에서 trim될 수 있어 NBSP를 사용한다.
fn pad_to_min_width(s: &str, min: usize) -> String {
    let len = s.chars().count();
    if len >= min {
        s.to_string()
    } else {
        let mut out = String::from(s);
        for _ in 0..(min - len) {
            out.push('\u{00A0}');
        }
        out
    }
}

fn focus_window(window: &WebviewWindow<tauri::Wry>) {
    let _ = window.show();
    let _ = window.unminimize();

    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::NSApplication;
        use objc2_foundation::MainThreadMarker;

        if let Some(mtm) = MainThreadMarker::new() {
            let ns_app = NSApplication::sharedApplication(mtm);
            ns_app.activate();
        }
    }

    let _ = window.set_focus();
}

#[cfg(target_os = "macos")]
fn has_foreground_window(app: &tauri::AppHandle) -> bool {
    FOREGROUND_WINDOW_LABELS
        .iter()
        .any(|label| app.get_webview_window(label).is_some())
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
        set_macos_foreground_visibility(app, has_foreground_window(app));
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
    .inner_size(660.0, 700.0)
    .resizable(true)
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
    crate::analytics::track_attendance_page_opened();

    if let Some(window) = app.get_webview_window("attendance") {
        show_foreground_app(app);
        focus_window(&window);
    } else {
        build_attendance_window(app);
    }
}

fn build_meal_plan_window(app: &tauri::AppHandle) {
    show_foreground_app(app);
    if let Ok(window) = tauri::WebviewWindowBuilder::new(
        app,
        "meal_plan",
        tauri::WebviewUrl::External(MEAL_PLAN_URL.parse().unwrap()),
    )
    .title("식단표")
    .inner_size(560.0, 820.0)
    .resizable(true)
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

fn open_meal_plan_window(app: &tauri::AppHandle) {
    log::info!("[tray] meal plan window opened");
    crate::analytics::track_meal_plan_opened();

    if let Some(window) = app.get_webview_window("meal_plan") {
        show_foreground_app(app);
        focus_window(&window);
    } else {
        build_meal_plan_window(app);
    }
}

fn build_settings_window(app: &tauri::AppHandle) {
    show_foreground_app(app);
    if let Ok(window) = tauri::WebviewWindowBuilder::new(app, "settings", tauri::WebviewUrl::App("index.html".into()))
        .title("설정")
        .inner_size(448.0, 608.0)
        .resizable(false)
        .minimizable(false)
        .maximizable(false)
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
            .inner_size(560.0, 784.0)
            .resizable(false)
            .minimizable(false)
            .maximizable(false)
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
    crate::analytics::track_onboarding_started();
}

fn open_settings_window(app: &tauri::AppHandle) {
    log::info!("[tray] settings window opened");
    crate::analytics::track_settings_opened();

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

fn handle_menu_event(app: &tauri::AppHandle, event_id: &str) {
    match event_id {
        "open_page" => run_window_task(app, |app| open_attendance_window(&app)),
        "meal_plan" => run_window_task(app, |app| open_meal_plan_window(&app)),
        "feedback" => {
            crate::analytics::track_feedback_opened();
            let _ = tauri_plugin_opener::open_url(FEEDBACK_URL, None::<&str>);
        }
        "settings" => run_window_task(app, |app| open_settings_window(&app)),
        "version" => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                crate::updater::prompt_and_install_update(app, false).await;
            });
        }
        "quit" => app.exit(0),
        _ => {}
    }
}

/// 시스템 트레이 생성: 아이콘, 메뉴, 이벤트 핸들러 설정.
pub fn setup_tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let show_dday = {
        let state: tauri::State<Arc<TokioMutex<AppState>>> = app.state();
        state.try_lock().map(|s| s.config.show_dday).unwrap_or(true)
    };

    // 전체에 다 pad_to_min_width해도 되지만, 항상 띄워지는거 하나만 있어도 괜찮음.
    let status_item = MenuItemBuilder::with_id("status", pad_to_min_width("상태 확인 중...", TRAY_STATUS_MIN_WIDTH))
        .enabled(false)
        .build(app)?;

    let dday_item = MenuItemBuilder::with_id("dday", pad_to_min_width("D-day 확인 중...", TRAY_STATUS_MIN_WIDTH))
        .enabled(false)
        .build(app)?;

    let open_page = MenuItemBuilder::with_id("open_page", "출석 페이지 열기").build(app)?;

    let meal_plan = MenuItemBuilder::with_id("meal_plan", "식단표 보러가기").build(app)?;

    let settings = MenuItemBuilder::with_id("settings", "설정...").build(app)?;

    let current_version = app.package_info().version.to_string();
    let version_item = MenuItemBuilder::with_id("version", format!("v{}", current_version))
        .enabled(false)
        .build(app)?;

    let feedback = MenuItemBuilder::with_id("feedback", "피드백 보내기").build(app)?;

    let quit = MenuItemBuilder::with_id("quit", "종료").build(app)?;

    let mut menu_builder = MenuBuilder::new(app).item(&status_item);
    if show_dday {
        menu_builder = menu_builder.item(&dday_item);
    }

    let menu = menu_builder
        .item(&open_page)
        .separator()
        .item(&meal_plan)
        .separator()
        .item(&version_item)
        .item(&feedback)
        .item(&settings)
        .item(&quit)
        .build()?;

    // 상태 아이템을 Tauri managed state에 저장해서 update_tray()에서 접근 가능하게 함.
    let tray_state = Arc::new(TokioMutex::new(TrayState {
        menu: menu.clone(),
        status_item: status_item.clone(),
        dday_item: dday_item.clone(),
        version_item: version_item.clone(),
        dday_visible: show_dday,
    }));
    app.manage(tray_state);

    let _tray = TrayIconBuilder::with_id("main-tray")
        .icon(Image::from_bytes(ICON_OFFLINE).expect("invalid icon PNG"))
        .tooltip("Jungle Bell - 상태 확인 중...")
        .menu(&menu)
        .on_menu_event(move |app, event| handle_menu_event(app, event.id().as_ref()))
        .build(app)?;

    Ok(())
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
    fn checker_재생성중은_회색_재확인으로_표시한다() {
        let view = build_tray_view_model(
            &snapshot(
                DailyPhase::NeedStart,
                Some(3600),
                true,
                false,
                CheckerRuntimeStatus::Recreating {
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
}

pub async fn sync_dday_menu_visibility(app: &tauri::AppHandle, visible: bool) -> Result<(), String> {
    let tray_state: tauri::State<Arc<TokioMutex<TrayState>>> = app.state();
    let mut ts = tray_state.lock().await;
    if visible == ts.dday_visible {
        return Ok(());
    }

    let result = if visible {
        ts.menu.insert(&ts.dday_item, DDAY_MENU_POSITION)
    } else {
        ts.menu.remove(&ts.dday_item)
    };

    if let Err(e) = result {
        log::warn!("[tray] D-day 메뉴 표시 상태 변경 실패: {}", e);
        return Err(e.to_string());
    }

    ts.dday_visible = visible;
    Ok(())
}

/// 트레이 버전 메뉴 아이템 갱신.
///
/// - `pending_update` = Some(version): "v{current} (업데이트 가능)" — 클릭 가능
/// - `pending_update` = None: "v{current}" — 비활성(회색)
pub fn update_tray_version(app: &tauri::AppHandle, pending_update: Option<String>) {
    let current_version = app.package_info().version.to_string();
    let (text, enabled) = if pending_update.is_some() {
        (format!("v{} (업데이트 가능)", current_version), true)
    } else {
        (format!("v{}", current_version), false)
    };
    let tray_state: tauri::State<Arc<TokioMutex<TrayState>>> = app.state();
    if let Ok(ts) = tray_state.try_lock() {
        let _ = ts.version_item.set_text(text);
        let _ = ts.version_item.set_enabled(enabled);
    };
}

/// 트레이 아이콘, 툴팁, 상태/D-Day 메뉴 텍스트 갱신.
/// 스케줄러(주기적)와 체커(보고 시) 양쪽에서 호출됨.
pub fn update_tray(app: &tauri::AppHandle, snapshot: &TraySnapshot) {
    let view = build_tray_view_model(snapshot, Utc::now());

    if let Some(tray) = app.tray_by_id("main-tray") {
        let _ = tray.set_icon(Some(icon_for_kind(view.icon)));
        let _ = tray.set_tooltip(Some(&view.tooltip));
    }

    // 상태 메뉴 아이템 텍스트 갱신.
    // try_lock 사용 — 락이 잡혀 있으면 이번 갱신은 건너뜀.
    let tray_state: tauri::State<Arc<TokioMutex<TrayState>>> = app.state();
    if let Ok(ts) = tray_state.try_lock() {
        let _ = ts
            .status_item
            .set_text(pad_to_min_width(&view.status_text, TRAY_STATUS_MIN_WIDTH));
        let _ = ts
            .dday_item
            .set_text(pad_to_min_width(&view.dday_text, TRAY_STATUS_MIN_WIDTH));
    };
}
