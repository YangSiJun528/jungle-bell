//! 체커 모듈 — hidden checker WebView supervisor와 runtime adapter.
//!
//! Vite가 생성한 checker script가 WebView에 주입되어 LMS REST API를 호출한다.
//! Rust가 `trigger_check()`로 이벤트를 발송하면,
//! JS가 API를 조회해 `report_checker_event` invoke로 반환한다.
//! 이 모듈은 WebView generation/readiness/report watchdog을 관리한다.

use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tauri::{
    plugin::{Builder as PluginBuilder, TauriPlugin},
    webview::{NewWindowResponse, PageLoadEvent},
    Emitter, Manager, Runtime, Url,
};
use tokio::sync::Mutex;

use crate::state::{AppState, CheckerRuntime, CheckerRuntimeStatus};
use crate::tray;

const ATTENDANCE_URL: &str = "https://jungle-lms.krafton.com/check-in";
pub(crate) const CHECKER_NO_REPORT_REFRESH_LIMIT: u32 = 3;
const CHECKER_REPORT_TIMEOUT: Duration = Duration::from_secs(7);

fn is_allowed_checker_navigation(url: &Url) -> bool {
    url.as_str() == "about:blank"
        || (url.scheme() == "https"
            && matches!(url.host_str(), Some("jungle-lms.krafton.com" | "accounts.google.com"))
            && url.port_or_known_default() == Some(443)
            && url.username().is_empty()
            && url.password().is_none())
}

pub(crate) fn navigation_guard<R: Runtime>() -> TauriPlugin<R> {
    PluginBuilder::new("checker-navigation-guard")
        .on_navigation(|webview, url| webview.label() != "checker" || is_allowed_checker_navigation(url))
        .build()
}

#[cfg(test)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CheckerWatchdogAction {
    Wait,
    Refresh { attempt: u32 },
    GiveUp,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CheckerEvent {
    PageLoaded,
    InteractivePageLoaded,
    Ready { generation: u64 },
    Report { generation: u64, api_error: bool },
    ReportTimeout { generation: u64 },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CheckerAction {
    TriggerCheck { generation: u64 },
    StartReportWatchdog { generation: u64 },
    Refresh { generation: u64, attempt: u32 },
    GiveUp { generation: u64 },
    IgnoreStale { generation: u64, current_generation: u64 },
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
struct CheckerTriggerPayload {
    generation: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CheckerRefreshAction {
    Reload,
    Navigate,
}

pub(crate) fn apply_supervisor_event(runtime: &mut CheckerRuntime, event: CheckerEvent) -> Vec<CheckerAction> {
    match event {
        CheckerEvent::PageLoaded => {
            runtime.page_load_generation = runtime.page_load_generation.saturating_add(1);
            let generation = runtime.page_load_generation;
            runtime.status = CheckerRuntimeStatus::PageLoaded { generation };
            vec![
                CheckerAction::TriggerCheck { generation },
                CheckerAction::StartReportWatchdog { generation },
            ]
        }
        CheckerEvent::InteractivePageLoaded => {
            runtime.page_load_generation = runtime.page_load_generation.saturating_add(1);
            let generation = runtime.page_load_generation;
            runtime.status = CheckerRuntimeStatus::PageLoaded { generation };
            vec![]
        }
        CheckerEvent::Ready { generation } => {
            if generation != runtime.page_load_generation {
                return vec![CheckerAction::IgnoreStale {
                    generation,
                    current_generation: runtime.page_load_generation,
                }];
            }
            runtime.ready_generation = generation;
            runtime.status = CheckerRuntimeStatus::Ready { generation };
            vec![]
        }
        CheckerEvent::Report { generation, api_error } => {
            if generation != runtime.page_load_generation {
                return vec![CheckerAction::IgnoreStale {
                    generation,
                    current_generation: runtime.page_load_generation,
                }];
            }
            runtime.report_generation = generation;
            runtime.no_report_refreshes = 0;
            runtime.status = if api_error {
                CheckerRuntimeStatus::Offline { generation }
            } else {
                CheckerRuntimeStatus::Healthy { generation }
            };
            vec![]
        }
        CheckerEvent::ReportTimeout { generation } => {
            if runtime.page_load_generation != generation || runtime.report_generation >= generation {
                return vec![];
            }
            if runtime.no_report_refreshes >= CHECKER_NO_REPORT_REFRESH_LIMIT {
                runtime.status = CheckerRuntimeStatus::Offline { generation };
                return vec![CheckerAction::GiveUp { generation }];
            }

            let attempt = runtime.no_report_refreshes.saturating_add(1);
            runtime.no_report_refreshes = attempt;
            runtime.status = CheckerRuntimeStatus::Refreshing { generation, attempt };
            vec![CheckerAction::Refresh { generation, attempt }]
        }
    }
}

pub(crate) fn record_checker_page_load(state: &mut AppState, page_url: &str) -> (u64, Vec<CheckerAction>) {
    state.checker.last_loaded_url = Some(safe_page_location(page_url));
    let event = if Url::parse(page_url).ok().as_ref().is_some_and(is_checker_report_origin) {
        CheckerEvent::PageLoaded
    } else {
        CheckerEvent::InteractivePageLoaded
    };
    let actions = apply_supervisor_event(&mut state.checker, event);
    (state.checker.page_load_generation, actions)
}

fn is_checker_report_origin(url: &Url) -> bool {
    url.scheme() == "https"
        && url.host_str() == Some("jungle-lms.krafton.com")
        && url.port_or_known_default() == Some(443)
        && url.username().is_empty()
        && url.password().is_none()
}

fn safe_page_location(page_url: &str) -> String {
    let Ok(mut url) = Url::parse(page_url) else {
        return "<invalid-url>".to_string();
    };
    let _ = url.set_username("");
    let _ = url.set_password(None);
    url.set_query(None);
    url.set_fragment(None);
    url.to_string()
}

pub(crate) fn record_checker_ready(state: &mut AppState, generation: u64) -> Vec<CheckerAction> {
    apply_supervisor_event(&mut state.checker, CheckerEvent::Ready { generation })
}

pub(crate) fn record_checker_report(state: &mut AppState, generation: u64, api_error: bool) -> Vec<CheckerAction> {
    apply_supervisor_event(&mut state.checker, CheckerEvent::Report { generation, api_error })
}

#[cfg(test)]
pub(crate) fn decide_checker_watchdog_action(state: &AppState, generation: u64) -> CheckerWatchdogAction {
    if state.checker.page_load_generation != generation || state.checker.report_generation >= generation {
        return CheckerWatchdogAction::Wait;
    }

    if state.checker.no_report_refreshes >= CHECKER_NO_REPORT_REFRESH_LIMIT {
        CheckerWatchdogAction::GiveUp
    } else {
        CheckerWatchdogAction::Refresh {
            attempt: state.checker.no_report_refreshes + 1,
        }
    }
}

#[cfg(test)]
pub(crate) fn record_checker_refresh(state: &mut AppState, generation: u64, attempt: u32) {
    state.checker.no_report_refreshes = state.checker.no_report_refreshes.saturating_add(1);
    state.checker.status = CheckerRuntimeStatus::Refreshing { generation, attempt };
}

#[cfg(test)]
pub(crate) fn record_checker_give_up(state: &mut AppState, generation: u64) {
    state.checker.status = CheckerRuntimeStatus::Offline { generation };
}

/// checker WebView에 trigger-check 이벤트를 발송.
/// JS가 이벤트를 수신하면 API를 조회해
/// `report_checker_event` invoke로 반환한다.
pub fn trigger_check(app: &tauri::AppHandle, generation: u64) -> bool {
    log::debug!("[checker] trigger_check emitted: generation={}", generation);
    let _ = app.emit_to(
        tauri::EventTarget::WebviewWindow {
            label: "checker".into(),
        },
        "trigger-check",
        CheckerTriggerPayload { generation },
    );
    true
}

async fn current_checker_generation(state: &Mutex<AppState>) -> u64 {
    state.lock().await.checker.page_load_generation
}

pub async fn trigger_current_check(app: &tauri::AppHandle) -> bool {
    let state: tauri::State<Arc<Mutex<AppState>>> = app.state();
    let generation = current_checker_generation(state.inner().as_ref()).await;
    trigger_check(app, generation)
}

/// checker WebView를 출석 페이지 기준으로 갱신한다.
///
/// 마지막 로드 완료 페이지가 출석 페이지면 `navigate()` 대신 `reload()`를 사용한다.
/// 같은 URL로 `navigate()`하면 WebView가 page-load를 만들지 않을 수 있기 때문이다.
/// 로그인 페이지 등 다른 URL이면 출석 페이지로 이동시킨다.
///
/// 네트워크 오류 중 macOS WKWebView의 URL은 `nil`일 수 있고 Wry 0.55의
/// `url()`은 이를 panic으로 처리하므로 네이티브 URL은 직접 조회하지 않는다.
pub fn refresh_webview(app: &tauri::AppHandle, reason: &str) -> bool {
    let Some(checker) = app.get_webview_window("checker") else {
        log::warn!("[checker] refresh skipped: checker window not found ({})", reason);
        return false;
    };

    let checker_visible = match checker.is_visible() {
        Ok(visible) => visible,
        Err(error) => {
            log::warn!("[checker] refresh deferred: LMS window visibility unavailable ({reason}): {error}");
            return false;
        }
    };
    if should_defer_automatic_refresh(checker_visible) {
        log::debug!("[checker] refresh deferred while LMS window is visible ({reason})");
        return true;
    }

    let target = ATTENDANCE_URL.parse().unwrap();
    let state: tauri::State<Arc<Mutex<AppState>>> = app.state();
    let last_loaded_url = state
        .try_lock()
        .ok()
        .and_then(|state| state.checker.last_loaded_url.clone());

    let result = match decide_refresh_action(last_loaded_url.as_deref()) {
        CheckerRefreshAction::Reload => {
            log::info!("[checker] webview reloaded ({})", reason);
            checker.reload()
        }
        CheckerRefreshAction::Navigate => {
            log::info!("[checker] webview navigated ({})", reason);
            checker.navigate(target)
        }
    };

    match result {
        Ok(_) => true,
        Err(e) => {
            log::warn!("[checker] refresh failed ({}): {}", reason, e);
            false
        }
    }
}

fn should_defer_automatic_refresh(checker_visible: bool) -> bool {
    checker_visible
}

fn decide_refresh_action(last_loaded_url: Option<&str>) -> CheckerRefreshAction {
    if last_loaded_url.is_some_and(|url| same_url_without_trailing_slash(url, ATTENDANCE_URL)) {
        CheckerRefreshAction::Reload
    } else {
        CheckerRefreshAction::Navigate
    }
}

fn same_url_without_trailing_slash(left: &str, right: &str) -> bool {
    left.trim_end_matches('/') == right.trim_end_matches('/')
}

pub(crate) fn build_webview(app: &tauri::AppHandle) -> tauri::Result<tauri::WebviewWindow> {
    let checker_script = include_str!("../../frontend/dist/desktop/injected/checker.js");
    let checker = tauri::WebviewWindowBuilder::new(
        app,
        "checker",
        tauri::WebviewUrl::External(ATTENDANCE_URL.parse().unwrap()),
    )
    .title("Jungle Campus")
    .inner_size(1100.0, 760.0)
    .min_inner_size(760.0, 560.0)
    .center()
    .resizable(true)
    .visible(false)
    .focused(false)
    .skip_taskbar(true)
    .devtools(false)
    .on_new_window(|_, _| NewWindowResponse::Deny)
    .initialization_script(checker_script)
    .on_page_load(|window, payload| {
        if payload.event() == PageLoadEvent::Finished {
            let app_handle = window.app_handle().clone();
            let page_url = payload.url().to_string();
            let page_location = safe_page_location(&page_url);
            tauri::async_runtime::spawn(async move {
                let state: tauri::State<Arc<Mutex<AppState>>> = app_handle.state();
                let (generation, actions) = {
                    let mut s = state.lock().await;
                    let result = record_checker_page_load(&mut s, &page_url);
                    s.notify_scheduler();
                    result
                };

                if actions.is_empty() {
                    log::debug!(
                        "[checker] interactive page loaded: generation={} location={}",
                        generation,
                        page_location,
                    );
                } else {
                    log::debug!(
                        "[checker] page loaded, triggering check: generation={} location={}",
                        generation,
                        page_location,
                    );
                }
                for action in actions {
                    match action {
                        CheckerAction::TriggerCheck { generation } => {
                            trigger_check(&app_handle, generation);
                        }
                        CheckerAction::StartReportWatchdog { generation } => {
                            spawn_report_watchdog(app_handle.clone(), generation, page_location.clone());
                        }
                        CheckerAction::Refresh { .. }
                        | CheckerAction::GiveUp { .. }
                        | CheckerAction::IgnoreStale { .. } => {}
                    }
                }
            });
        }
    })
    .build()?;

    let app_handle = app.clone();
    checker.on_window_event(move |event| match event {
        tauri::WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            if let Some(window) = app_handle.get_webview_window("checker") {
                let _ = window.set_skip_taskbar(true);
                let _ = window.hide();
                crate::tray::sync_foreground_app_visibility(&app_handle);
                if !refresh_webview(&app_handle, "LMS window closed") {
                    log::warn!("[checker] LMS session recheck failed after window close");
                }
            }
        }
        tauri::WindowEvent::ThemeChanged(theme) => {
            if let Err(error) = crate::tray::sync_icon_theme(&app_handle, *theme) {
                log::warn!("[checker] tray theme sync failed: {error}");
            }
        }
        _ => {}
    });

    Ok(checker)
}

pub(crate) fn show_lms_window(app: &tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("checker")
        .ok_or_else(|| "LMS_CHECKER_UNAVAILABLE".to_string())?;
    window
        .set_skip_taskbar(false)
        .map_err(|error| format!("LMS_WINDOW_TASKBAR_FAILED: {error}"))?;
    window
        .unminimize()
        .map_err(|error| format!("LMS_WINDOW_RESTORE_FAILED: {error}"))?;
    window
        .show()
        .map_err(|error| format!("LMS_WINDOW_SHOW_FAILED: {error}"))?;
    crate::tray::sync_foreground_app_visibility(app);
    window
        .set_focus()
        .map_err(|error| format!("LMS_WINDOW_FOCUS_FAILED: {error}"))
}

fn spawn_report_watchdog(app: tauri::AppHandle, generation: u64, page_location: String) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(CHECKER_REPORT_TIMEOUT).await;

        let checker_visible = app
            .get_webview_window("checker")
            .map(|window| window.is_visible().unwrap_or(true))
            .unwrap_or(false);
        if should_defer_automatic_refresh(checker_visible) {
            log::debug!(
                "[checker] watchdog deferred while LMS window is visible: generation={} location={}",
                generation,
                page_location,
            );
            return;
        }

        let state: tauri::State<Arc<Mutex<AppState>>> = app.state();
        let (actions, ready_generation, report_generation, tray_snapshot) = {
            let mut s = state.lock().await;
            let actions = apply_supervisor_event(&mut s.checker, CheckerEvent::ReportTimeout { generation });
            s.notify_scheduler();
            let tray_snapshot = if actions
                .iter()
                .any(|action| matches!(action, CheckerAction::Refresh { .. } | CheckerAction::GiveUp { .. }))
            {
                Some(s.tray_snapshot(None))
            } else {
                None
            };
            (
                actions,
                s.checker.ready_generation,
                s.checker.report_generation,
                tray_snapshot,
            )
        };

        if let Some(snapshot) = tray_snapshot {
            if let Err(error) = tray::update_tray(&app, &snapshot) {
                log::error!("[checker] tray projection update failed: {error}");
            }
        }

        for action in actions {
            match action {
                CheckerAction::Refresh { attempt, .. } => {
                    let reason = format!("no report after page load generation={generation} attempt={attempt}");
                    log::warn!(
                        "[checker] watchdog: {} location={} ready_generation={} report_generation={}",
                        reason,
                        page_location,
                        ready_generation,
                        report_generation,
                    );
                    if !refresh_webview(&app, &reason) {
                        log::error!("[checker] watchdog refresh failed: {}", reason);
                    }
                }
                CheckerAction::GiveUp { .. } => {
                    log::error!(
                        "[checker] watchdog: no report after page load generation={} location={} ready_generation={} report_generation={} recreate_limit={}",
                        generation,
                        page_location,
                        ready_generation,
                        report_generation,
                        CHECKER_NO_REPORT_REFRESH_LIMIT,
                    );
                }
                CheckerAction::TriggerCheck { .. }
                | CheckerAction::StartReportWatchdog { .. }
                | CheckerAction::IgnoreStale { .. } => {}
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::attendance::{apply_attendance_report, AttendanceReport, CohortReportStatus};
    use crate::config::Config;
    use crate::state::{DailyPhase, DdayStatus};
    use chrono::{DateTime, FixedOffset, NaiveDate, TimeZone, Utc};

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

    #[tokio::test]
    async fn 수동_출석_갱신은_상태_잠금이_잠시_사용중이어도_기다린다() {
        let state = Arc::new(Mutex::new(default_state()));
        let mut held = state.lock().await;
        held.checker.page_load_generation = 7;

        let waiting_state = state.clone();
        let waiting = tokio::spawn(async move { current_checker_generation(waiting_state.as_ref()).await });
        tokio::task::yield_now().await;
        assert!(!waiting.is_finished());

        drop(held);
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(1), waiting)
                .await
                .unwrap()
                .unwrap(),
            7
        );
    }

    #[test]
    fn checker_url이_없으면_navigate로_갱신한다() {
        assert_eq!(decide_refresh_action(None), CheckerRefreshAction::Navigate);
    }

    #[test]
    fn checker_page_load_url을_기록해_갱신_방식을_결정한다() {
        let mut state = default_state();

        record_checker_page_load(&mut state, ATTENDANCE_URL);

        assert_eq!(
            decide_refresh_action(state.checker.last_loaded_url.as_deref()),
            CheckerRefreshAction::Reload
        );
    }

    #[test]
    fn google_로그인_페이지는_checker_보고와_watchdog을_기대하지_않는다() {
        let mut state = default_state();
        let google_login = "https://accounts.google.com/v3/signin/identifier?continue=sensitive-oauth-state#step";

        let (generation, actions) = record_checker_page_load(&mut state, google_login);

        assert_eq!(generation, 1);
        assert!(actions.is_empty());
        assert_eq!(
            state.checker.last_loaded_url.as_deref(),
            Some("https://accounts.google.com/v3/signin/identifier")
        );
    }

    #[test]
    fn google_로그인_이동은_이전_checker_watchdog을_무효화한다() {
        let mut state = default_state();
        let (checker_generation, _) = record_checker_page_load(&mut state, ATTENDANCE_URL);

        let (login_generation, actions) = record_checker_page_load(
            &mut state,
            "https://accounts.google.com/v3/signin/challenge/pwd?state=secret",
        );

        assert_eq!(login_generation, checker_generation + 1);
        assert!(actions.is_empty());
        assert!(apply_supervisor_event(
            &mut state.checker,
            CheckerEvent::ReportTimeout {
                generation: checker_generation,
            },
        )
        .is_empty());
    }

    #[test]
    fn 표시중인_lms_창은_자동_갱신을_미룬다() {
        assert!(should_defer_automatic_refresh(true));
        assert!(!should_defer_automatic_refresh(false));
    }

    fn process_report(
        state: &mut AppState,
        report: &AttendanceReport,
        now: DateTime<Utc>,
    ) -> Option<(DailyPhase, Option<i64>)> {
        apply_attendance_report(state, report, now).map(|update| (update.phase, update.remaining))
    }

    #[test]
    fn checker_page_load_세대가_증가한다() {
        let mut state = default_state();

        let (first, _) = record_checker_page_load(&mut state, ATTENDANCE_URL);
        let (second, _) = record_checker_page_load(&mut state, ATTENDANCE_URL);

        assert_eq!(first, 1);
        assert_eq!(second, 2);
        assert_eq!(state.checker.page_load_generation, 2);
        assert_eq!(state.checker.status, CheckerRuntimeStatus::PageLoaded { generation: 2 });
    }

    #[test]
    fn checker_report가_오면_watchdog은_대기한다() {
        let mut state = default_state();
        let (generation, _) = record_checker_page_load(&mut state, ATTENDANCE_URL);

        record_checker_report(&mut state, generation, false);

        assert_eq!(
            decide_checker_watchdog_action(&state, generation),
            CheckerWatchdogAction::Wait
        );
        assert_eq!(state.checker.status, CheckerRuntimeStatus::Healthy { generation });
    }

    #[test]
    fn checker_report가_없으면_watchdog은_갱신을_요구한다() {
        let mut state = default_state();
        let (generation, _) = record_checker_page_load(&mut state, ATTENDANCE_URL);

        assert_eq!(
            decide_checker_watchdog_action(&state, generation),
            CheckerWatchdogAction::Refresh { attempt: 1 }
        );
    }

    #[test]
    fn 오래된_checker_watchdog은_무시한다() {
        let mut state = default_state();
        let (stale_generation, _) = record_checker_page_load(&mut state, ATTENDANCE_URL);
        record_checker_page_load(&mut state, ATTENDANCE_URL);

        assert_eq!(
            decide_checker_watchdog_action(&state, stale_generation),
            CheckerWatchdogAction::Wait
        );
    }

    #[test]
    fn checker_갱신_한도에_도달하면_중단한다() {
        let mut state = default_state();
        let (generation, _) = record_checker_page_load(&mut state, ATTENDANCE_URL);
        state.checker.no_report_refreshes = CHECKER_NO_REPORT_REFRESH_LIMIT;

        assert_eq!(
            decide_checker_watchdog_action(&state, generation),
            CheckerWatchdogAction::GiveUp
        );
    }

    #[test]
    fn checker_갱신은_상태에_attempt를_남긴다() {
        let mut state = default_state();
        let (generation, _) = record_checker_page_load(&mut state, ATTENDANCE_URL);

        record_checker_refresh(&mut state, generation, 1);

        assert_eq!(state.checker.no_report_refreshes, 1);
        assert_eq!(
            state.checker.status,
            CheckerRuntimeStatus::Refreshing { generation, attempt: 1 }
        );
    }

    #[test]
    fn checker_give_up은_offline_상태로_남긴다() {
        let mut state = default_state();
        let (generation, _) = record_checker_page_load(&mut state, ATTENDANCE_URL);
        state.lms_authentication = crate::state::LmsAuthenticationState::Authenticated;

        record_checker_give_up(&mut state, generation);

        assert_eq!(state.checker.status, CheckerRuntimeStatus::Offline { generation });
        assert_eq!(
            state.lms_authentication,
            crate::state::LmsAuthenticationState::Authenticated,
        );
    }

    #[test]
    fn api_에러시_데이터_로드_상태만_설정된다() {
        // given
        let mut state = default_state();
        let report = AttendanceReport {
            generation: 1,
            needs_login: false,
            morning_done: false,
            evening_done: false,
            api_error: true,
            cohort_status: CohortReportStatus::Unknown,
            cohort_start_date: None,
            cohort_end_date: None,
        };

        // when
        let result = process_report(&mut state, &report, kst_time(9, 0, 0));

        // then
        assert!(result.is_none());
        assert!(state.data_loaded);
    }

    #[test]
    fn 출석_api_에러여도_코호트_dday는_반영한다() {
        // given
        let mut state = default_state();
        let report = AttendanceReport {
            generation: 1,
            needs_login: false,
            morning_done: false,
            evening_done: false,
            api_error: true,
            cohort_status: CohortReportStatus::Active,
            cohort_start_date: Some("2026-03-01".into()),
            cohort_end_date: Some("2026-03-31".into()),
        };

        // when
        let result = process_report(&mut state, &report, kst_time(9, 0, 0));

        // then
        assert!(result.is_none());
        assert_eq!(
            state.dday_status,
            DdayStatus::Active {
                end_date: NaiveDate::from_ymd_opt(2026, 3, 31).unwrap()
            }
        );
        assert_eq!(
            state.cohort_period,
            Some(crate::state::CohortPeriod {
                start_date: NaiveDate::from_ymd_opt(2026, 3, 1).unwrap(),
                end_date: NaiveDate::from_ymd_opt(2026, 3, 31).unwrap(),
            })
        );
    }

    #[test]
    fn 로그인_필요시_페이즈는_시간에_따라_계산된다() {
        // given
        let mut state = default_state();
        let report = AttendanceReport {
            generation: 1,
            needs_login: true,
            morning_done: false,
            evening_done: false,
            api_error: false,
            cohort_status: CohortReportStatus::Unknown,
            cohort_start_date: None,
            cohort_end_date: None,
        };

        // when
        let result = process_report(&mut state, &report, kst_time(9, 0, 0));

        // then
        assert!(result.is_some());
        let (phase, remaining) = result.unwrap();
        assert_eq!(phase, DailyPhase::NeedStart);
        assert!(remaining.is_some());
        assert!(state.needs_login);
        assert_eq!(state.dday_status, DdayStatus::LoginRequired);
    }

    #[test]
    fn 오전_출석_완료시_학습중_상태가_된다() {
        // given
        let mut state = default_state();
        let report = AttendanceReport {
            generation: 1,
            needs_login: false,
            morning_done: true,
            evening_done: false,
            api_error: false,
            cohort_status: CohortReportStatus::Active,
            cohort_start_date: Some("2026-03-01".into()),
            cohort_end_date: Some("2026-03-31".into()),
        };

        // when: KST 12:00 — 체크인 완료, 체크아웃 전
        let result = process_report(&mut state, &report, kst_time(12, 0, 0));

        // then
        let (phase, _) = result.unwrap();
        assert_eq!(phase, DailyPhase::Studying);
        assert!(state.morning_checked);
        assert!(!state.evening_checked);
        assert_eq!(
            state.dday_status,
            DdayStatus::Active {
                end_date: NaiveDate::from_ymd_opt(2026, 3, 31).unwrap()
            }
        );
    }

    #[test]
    fn 오전_오후_모두_완료시_완료_상태가_된다() {
        // given
        let mut state = default_state();
        let report = AttendanceReport {
            generation: 1,
            needs_login: false,
            morning_done: true,
            evening_done: true,
            api_error: false,
            cohort_status: CohortReportStatus::Active,
            cohort_start_date: Some("2026-03-01".into()),
            cohort_end_date: Some("2026-03-31".into()),
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
            generation: 1,
            needs_login: false,
            morning_done: false,
            evening_done: false,
            api_error: false,
            cohort_status: CohortReportStatus::Active,
            cohort_start_date: Some("2026-03-01".into()),
            cohort_end_date: Some("2026-03-31".into()),
        };

        // when: KST 11:00 — morning_end(10:00) 지남, 미체크인
        let result = process_report(&mut state, &report, kst_time(11, 0, 0));

        // then
        let (phase, _) = result.unwrap();
        assert_eq!(phase, DailyPhase::StartOverdue);
    }

    #[test]
    fn 진행중인_코호트가_없으면_idle_상태가_된다() {
        // given
        let mut state = default_state();
        let report = AttendanceReport {
            generation: 1,
            needs_login: false,
            morning_done: false,
            evening_done: false,
            api_error: false,
            cohort_status: CohortReportStatus::NoCohort,
            cohort_start_date: None,
            cohort_end_date: None,
        };

        // when
        let result = process_report(&mut state, &report, kst_time(9, 0, 0));

        // then
        let (phase, remaining) = result.unwrap();
        assert_eq!(phase, DailyPhase::Idle);
        assert!(remaining.is_none());
        assert_eq!(state.dday_status, DdayStatus::NoCohort);
    }

    #[test]
    fn 종료된_코호트는_idle_상태가_된다() {
        // given
        let mut state = default_state();
        let report = AttendanceReport {
            generation: 1,
            needs_login: false,
            morning_done: false,
            evening_done: false,
            api_error: false,
            cohort_status: CohortReportStatus::Ended,
            cohort_start_date: Some("2026-01-01".into()),
            cohort_end_date: Some("2026-03-01".into()),
        };

        // when
        let result = process_report(&mut state, &report, kst_time(9, 0, 0));

        // then
        let (phase, remaining) = result.unwrap();
        assert_eq!(phase, DailyPhase::Idle);
        assert!(remaining.is_none());
        assert_eq!(state.dday_status, DdayStatus::Ended);
    }

    #[test]
    fn supervisor는_page_load_ready_report를_generation으로_전이한다() {
        let mut runtime = crate::state::CheckerRuntime::default();

        let actions = apply_supervisor_event(&mut runtime, CheckerEvent::PageLoaded);

        assert_eq!(
            actions,
            vec![
                CheckerAction::TriggerCheck { generation: 1 },
                CheckerAction::StartReportWatchdog { generation: 1 },
            ]
        );
        assert_eq!(runtime.status, CheckerRuntimeStatus::PageLoaded { generation: 1 });

        assert_eq!(
            apply_supervisor_event(&mut runtime, CheckerEvent::Ready { generation: 1 }),
            vec![]
        );
        assert_eq!(runtime.status, CheckerRuntimeStatus::Ready { generation: 1 });

        assert_eq!(
            apply_supervisor_event(
                &mut runtime,
                CheckerEvent::Report {
                    generation: 1,
                    api_error: false,
                },
            ),
            vec![]
        );
        assert_eq!(runtime.status, CheckerRuntimeStatus::Healthy { generation: 1 });
        assert_eq!(runtime.report_generation, 1);
    }

    #[test]
    fn supervisor는_이전_generation_report를_무시한다() {
        let mut runtime = crate::state::CheckerRuntime::default();

        apply_supervisor_event(&mut runtime, CheckerEvent::PageLoaded);
        apply_supervisor_event(&mut runtime, CheckerEvent::PageLoaded);

        let actions = apply_supervisor_event(
            &mut runtime,
            CheckerEvent::Report {
                generation: 1,
                api_error: false,
            },
        );

        assert_eq!(
            actions,
            vec![CheckerAction::IgnoreStale {
                generation: 1,
                current_generation: 2,
            }]
        );
        assert_eq!(runtime.report_generation, 0);
        assert_eq!(runtime.status, CheckerRuntimeStatus::PageLoaded { generation: 2 });
    }

    #[test]
    fn supervisor_watchdog는_refresh와_give_up을_명시한다() {
        let mut runtime = crate::state::CheckerRuntime::default();
        apply_supervisor_event(&mut runtime, CheckerEvent::PageLoaded);

        assert_eq!(
            apply_supervisor_event(&mut runtime, CheckerEvent::ReportTimeout { generation: 1 }),
            vec![CheckerAction::Refresh {
                generation: 1,
                attempt: 1,
            }]
        );
        assert_eq!(
            runtime.status,
            CheckerRuntimeStatus::Refreshing {
                generation: 1,
                attempt: 1,
            }
        );

        runtime.no_report_refreshes = CHECKER_NO_REPORT_REFRESH_LIMIT;

        assert_eq!(
            apply_supervisor_event(&mut runtime, CheckerEvent::ReportTimeout { generation: 1 }),
            vec![CheckerAction::GiveUp { generation: 1 }]
        );
        assert_eq!(runtime.status, CheckerRuntimeStatus::Offline { generation: 1 });
    }

    #[test]
    fn checker_navigation은_exact_lms와_google_login만_허용한다() {
        for allowed in [
            "about:blank",
            "https://jungle-lms.krafton.com/check-in",
            "https://accounts.google.com/o/oauth2/v2/auth",
        ] {
            assert!(
                is_allowed_checker_navigation(&Url::parse(allowed).unwrap()),
                "{allowed}"
            );
        }
        for denied in [
            "http://jungle-lms.krafton.com/check-in",
            "https://jungle-lms.krafton.com.evil.test/check-in",
            "https://user@jungle-lms.krafton.com/check-in",
            "https://jungle-lms.krafton.com:444/check-in",
            "https://google.com/",
            "javascript:alert(1)",
        ] {
            assert!(!is_allowed_checker_navigation(&Url::parse(denied).unwrap()), "{denied}");
        }
    }

    #[test]
    fn checker_builder는_devtools와_새창을_명시적으로_차단한다() {
        let source = include_str!("checker.rs");
        assert!(source.contains(".devtools(false)"));
        assert!(source.contains(".on_new_window(|_, _| NewWindowResponse::Deny)"));
    }
}
