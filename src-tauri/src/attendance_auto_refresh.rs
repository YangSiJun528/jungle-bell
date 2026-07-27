use std::sync::Arc;
use std::time::Duration;

use tauri::Manager;
use tokio::sync::Mutex;

use crate::checker;
use crate::state::AppState;

pub(crate) const CONFIRMATION_CHECK_LIMIT: u32 = 8;
const INITIAL_CONFIRMATION_DELAY: Duration = Duration::from_millis(350);
const CONFIRMATION_CHECK_INTERVAL: Duration = Duration::from_millis(900);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum StartRequestAction {
    StartPolling { request_id: u64 },
    AlreadyPending,
    AlreadyConfirmed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PollAction {
    TriggerCheck { attempt: u32 },
    TimedOut,
    Stop,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct PendingRefresh {
    request_id: u64,
    checks_requested: u32,
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(crate) struct AttendanceAutoRefreshRuntime {
    next_request_id: u64,
    pending: Option<PendingRefresh>,
}

pub(crate) fn request_start_confirmation(
    runtime: &mut AttendanceAutoRefreshRuntime,
    morning_checked: bool,
) -> StartRequestAction {
    if morning_checked {
        runtime.pending = None;
        return StartRequestAction::AlreadyConfirmed;
    }
    if runtime.pending.is_some() {
        return StartRequestAction::AlreadyPending;
    }

    runtime.next_request_id = runtime.next_request_id.saturating_add(1);
    let request_id = runtime.next_request_id;
    runtime.pending = Some(PendingRefresh {
        request_id,
        checks_requested: 0,
    });
    StartRequestAction::StartPolling { request_id }
}

pub(crate) fn next_confirmation_check(runtime: &mut AttendanceAutoRefreshRuntime, request_id: u64) -> PollAction {
    let Some(pending) = runtime.pending.as_mut() else {
        return PollAction::Stop;
    };
    if pending.request_id != request_id {
        return PollAction::Stop;
    }
    if pending.checks_requested >= CONFIRMATION_CHECK_LIMIT {
        runtime.pending = None;
        return PollAction::TimedOut;
    }

    pending.checks_requested += 1;
    PollAction::TriggerCheck {
        attempt: pending.checks_requested,
    }
}

pub(crate) fn confirm_start(
    runtime: &mut AttendanceAutoRefreshRuntime,
    morning_done: bool,
    needs_login: bool,
    api_error: bool,
) -> bool {
    if runtime.pending.is_some() && morning_done && !needs_login && !api_error {
        runtime.pending = None;
        return true;
    }
    false
}

fn cancel_confirmation(runtime: &mut AttendanceAutoRefreshRuntime, request_id: u64) {
    if runtime.pending.is_some_and(|pending| pending.request_id == request_id) {
        runtime.pending = None;
    }
}

pub(crate) fn spawn_confirmation_poll(app: tauri::AppHandle, request_id: u64) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(INITIAL_CONFIRMATION_DELAY).await;

        loop {
            if app.get_webview_window("attendance").is_none() {
                let state: tauri::State<Arc<Mutex<AppState>>> = app.state();
                cancel_confirmation(&mut state.lock().await.attendance_auto_refresh, request_id);
                log::debug!("[attendance-refresh] confirmation cancelled: attendance window closed");
                return;
            }

            let (action, checker_generation) = {
                let state: tauri::State<Arc<Mutex<AppState>>> = app.state();
                let mut state = state.lock().await;
                let action = next_confirmation_check(&mut state.attendance_auto_refresh, request_id);
                (action, state.checker.page_load_generation)
            };

            match action {
                PollAction::TriggerCheck { attempt } => {
                    log::debug!(
                        "[attendance-refresh] requesting checker confirmation: request_id={} attempt={}",
                        request_id,
                        attempt,
                    );
                    checker::trigger_check(&app, checker_generation);
                    tokio::time::sleep(CONFIRMATION_CHECK_INTERVAL).await;
                }
                PollAction::TimedOut => {
                    log::warn!(
                        "[attendance-refresh] confirmation timed out: request_id={} attempts={}",
                        request_id,
                        CONFIRMATION_CHECK_LIMIT,
                    );
                    return;
                }
                PollAction::Stop => return,
            }
        }
    });
}

pub(crate) fn reload_attendance_window(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("attendance") else {
        log::debug!("[attendance-refresh] reload skipped: attendance window closed");
        return;
    };

    match window.reload() {
        Ok(()) => log::info!("[attendance-refresh] attendance page reloaded after server confirmation"),
        Err(error) => log::warn!("[attendance-refresh] attendance page reload failed: {error}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 미확인_상태의_첫_요청만_polling을_시작한다() {
        let mut runtime = AttendanceAutoRefreshRuntime::default();

        let first = request_start_confirmation(&mut runtime, false);
        let second = request_start_confirmation(&mut runtime, false);

        assert_eq!(first, StartRequestAction::StartPolling { request_id: 1 });
        assert_eq!(second, StartRequestAction::AlreadyPending);
    }

    #[test]
    fn 이미_학습을_시작했으면_요청을_무시한다() {
        let mut runtime = AttendanceAutoRefreshRuntime::default();

        assert_eq!(
            request_start_confirmation(&mut runtime, true),
            StartRequestAction::AlreadyConfirmed
        );
    }

    #[test]
    fn 현재_요청만_정해진_횟수까지_checker를_호출한다() {
        let mut runtime = AttendanceAutoRefreshRuntime::default();
        let StartRequestAction::StartPolling { request_id } = request_start_confirmation(&mut runtime, false) else {
            panic!("polling request expected");
        };

        assert_eq!(next_confirmation_check(&mut runtime, request_id + 1), PollAction::Stop);
        for attempt in 1..=CONFIRMATION_CHECK_LIMIT {
            assert_eq!(
                next_confirmation_check(&mut runtime, request_id),
                PollAction::TriggerCheck { attempt }
            );
        }
        assert_eq!(next_confirmation_check(&mut runtime, request_id), PollAction::TimedOut);
        assert_eq!(next_confirmation_check(&mut runtime, request_id), PollAction::Stop);
        assert_eq!(
            request_start_confirmation(&mut runtime, false),
            StartRequestAction::StartPolling { request_id: 2 }
        );
    }

    #[test]
    fn 성공한_checker_보고만_새로고침을_승인한다() {
        let mut runtime = AttendanceAutoRefreshRuntime::default();
        request_start_confirmation(&mut runtime, false);

        assert!(!confirm_start(&mut runtime, false, false, false));
        assert!(!confirm_start(&mut runtime, true, true, false));
        assert!(!confirm_start(&mut runtime, true, false, true));
        assert!(confirm_start(&mut runtime, true, false, false));
        assert!(!confirm_start(&mut runtime, true, false, false));
    }
}
