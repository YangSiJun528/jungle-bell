//! 체커 모듈 — hidden checker WebView supervisor와 runtime adapter.
//!
//! Vite가 생성한 checker script가 WebView에 주입되어 LMS REST API를 호출한다.
//! Rust가 `trigger_check()`로 이벤트를 발송하면,
//! JS가 API를 조회해 `report_attendance_status` invoke로 반환한다.
//! 이 모듈은 WebView generation/readiness/report watchdog을 관리한다.

use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tauri::{webview::PageLoadEvent, Emitter, Manager};
use tokio::sync::Mutex;

use crate::state::{AppState, CheckerRuntime, CheckerRuntimeStatus};
use crate::tray;

const ATTENDANCE_URL: &str = "https://jungle-lms.krafton.com/check-in";
pub(crate) const CHECKER_NO_REPORT_REFRESH_LIMIT: u32 = 3;
const CHECKER_REPORT_TIMEOUT: Duration = Duration::from_secs(7);

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
    state.checker.last_loaded_url = Some(page_url.to_string());
    let actions = apply_supervisor_event(&mut state.checker, CheckerEvent::PageLoaded);
    (state.checker.page_load_generation, actions)
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
/// `report_attendance_status` invoke로 반환한다.
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

pub fn trigger_current_check(app: &tauri::AppHandle) -> bool {
    let state: tauri::State<Arc<Mutex<AppState>>> = app.state();
    let Ok(s) = state.try_lock() else {
        log::warn!("[checker] trigger_check skipped: state locked");
        return false;
    };
    trigger_check(app, s.checker.page_load_generation)
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
    let checker_script = include_str!("../../dist/injected/checker.js");
    let checker = tauri::WebviewWindowBuilder::new(
        app,
        "checker",
        tauri::WebviewUrl::External(ATTENDANCE_URL.parse().unwrap()),
    )
    .title("Jungle Bell")
    .visible(false)
    .focused(false)
    .skip_taskbar(true)
    .initialization_script(checker_script)
    .on_page_load(|window, payload| {
        if payload.event() == PageLoadEvent::Finished {
            let app_handle = window.app_handle().clone();
            let page_url = payload.url().to_string();
            tauri::async_runtime::spawn(async move {
                let state: tauri::State<Arc<Mutex<AppState>>> = app_handle.state();
                let (generation, actions) = {
                    let mut s = state.lock().await;
                    let result = record_checker_page_load(&mut s, &page_url);
                    s.notify_scheduler();
                    result
                };

                log::debug!(
                    "[checker] page loaded, triggering check: generation={} url={}",
                    generation,
                    page_url,
                );
                for action in actions {
                    match action {
                        CheckerAction::TriggerCheck { generation } => {
                            trigger_check(&app_handle, generation);
                        }
                        CheckerAction::StartReportWatchdog { generation } => {
                            spawn_report_watchdog(app_handle.clone(), generation, page_url.clone());
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
                let _ = window.hide();
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

fn spawn_report_watchdog(app: tauri::AppHandle, generation: u64, page_url: String) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(CHECKER_REPORT_TIMEOUT).await;

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
                        "[checker] watchdog: {} url={} ready_generation={} report_generation={}",
                        reason,
                        page_url,
                        ready_generation,
                        report_generation,
                    );
                    if !refresh_webview(&app, &reason) {
                        log::error!("[checker] watchdog refresh failed: {}", reason);
                    }
                }
                CheckerAction::GiveUp { .. } => {
                    log::error!(
                        "[checker] watchdog: no report after page load generation={} url={} ready_generation={} report_generation={} recreate_limit={}",
                        generation,
                        page_url,
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

        record_checker_give_up(&mut state, generation);

        assert_eq!(state.checker.status, CheckerRuntimeStatus::Offline { generation });
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
}
