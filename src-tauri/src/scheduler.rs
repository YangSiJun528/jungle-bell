//! 스케줄러 모듈 — 앱의 주기적 로직을 구동하는 백그라운드 루프.
//!
//! tokio 태스크로 실행되며, 적응형 간격으로 틱:
//!   - 5초: 첫 체커 보고 대기 중
//!   - 60초: 사용자 액션 필요 시 (NeedStart, StartOverdue, NeedEnd)
//!   - 300초: 대기 중 (Studying, Complete, Idle)
//!
//! 매 틱마다: 날짜 변경 시 일일 리셋, 상태 계산, 트레이 갱신,
//! 체커 WebView 주기적 리로드를 수행.
//! API 기반 조회를 사용하므로 DOM 의존성 없이 안정적으로 동작.

use std::sync::Arc;

use chrono::{DateTime, Datelike, FixedOffset, Timelike, Utc};
use log::{debug, info};
use tokio::sync::Mutex;

use tauri::Manager;
use tauri_plugin_notification::NotificationExt;

use crate::checker;
use crate::config::Config;
use crate::state::{self, kst, AppState, DailyPhase};
use crate::tray;

/// 액션 필요 시 틱 간격 (초). API 호출 빈도를 줄이기 위해 60초.
const TICK_INTERVAL_ACTIVE: u64 = 60;
/// 대기 시 틱 간격 (초). 5분 간격으로 상태 확인.
const TICK_INTERVAL_IDLE: u64 = 300;

/// 체커 WebView 리로드 간격 (초). 세션/토큰 갱신 목적.
/// 액세스 토큰이 1시간 만료이므로 15분 간격으로 리로드하여 갱신.
const RELOAD_INTERVAL_NORMAL: u64 = 15 * 60; // 15분

/// 알림 판단 결과.
pub(crate) struct NotificationDecision {
    pub send: bool,
    pub message: Option<(&'static str, String)>,
}

/// 틱 한 번의 순수 계산 결과. 부수효과는 호출자가 수행.
pub(crate) struct TickResult {
    /// 다음 틱까지 대기할 초.
    pub tick_interval: u64,
    /// 체커 WebView를 리로드해야 하는지 여부.
    pub should_reload: bool,
    /// phase가 변경되었는지 여부.
    pub phase_changed: bool,
    /// 발송할 알림 (제목, 본문). None이면 발송하지 않음.
    pub notification: Option<(&'static str, String)>,
    /// 트레이 갱신 정보. None이면 갱신하지 않음 (data_loaded 전).
    pub tray_update: Option<(DailyPhase, Option<i64>, bool)>,
    /// 일일 리셋이 수행되었는지 여부.
    pub daily_reset: bool,
}

/// 일일 리셋 판단: KST 날짜가 바뀌고 morning_start 이후이면 리셋 수행.
///
/// 리셋이 수행되면 `true` 반환.
pub(crate) fn check_daily_reset(state: &mut AppState, kst_now: DateTime<FixedOffset>) -> bool {
    let current_day = kst_now.ordinal();
    let current_hour = kst_now.hour();

    if let Some(last_day) = state.last_reset_day {
        if current_day != last_day && current_hour >= state.config.morning_start.hour {
            state.morning_checked = false;
            state.evening_checked = false;
            state.last_reset_day = Some(current_day);
            return true;
        }
    } else {
        state.last_reset_day = Some(current_day);
    }
    false
}

/// 알림 발송 여부 판단 (순수 함수).
///
/// `secs_since_last`: 마지막 알림 이후 경과 초. `None`이면 알림 미발송 상태.
pub(crate) fn should_notify(
    config: &Config,
    phase: DailyPhase,
    remaining: Option<i64>,
    needs_login: bool,
    kst_now: DateTime<FixedOffset>,
    secs_since_last: Option<u64>,
) -> NotificationDecision {
    if !config.notification_enabled || needs_login {
        return NotificationDecision { send: false, message: None };
    }

    let actionable = matches!(
        phase,
        DailyPhase::NeedStart | DailyPhase::StartOverdue | DailyPhase::NeedEnd
    );
    if !actionable {
        return NotificationDecision { send: false, message: None };
    }

    let kst_mins = (kst_now.hour() * 60 + kst_now.minute()) as i32;
    let notif_start_mins =
        (config.notification_start.hour * 60 + config.notification_start.minute) as i32;
    let notif_end_mins =
        (config.notification_end.hour * 60 + config.notification_end.minute) as i32;
    let evening_start_mins =
        (config.evening_start.hour * 60 + config.evening_start.minute) as i32;

    let in_window = match phase {
        DailyPhase::NeedStart | DailyPhase::StartOverdue => {
            kst_mins >= notif_start_mins
        }
        DailyPhase::NeedEnd => {
            if notif_end_mins <= evening_start_mins {
                // 자정 넘김 (예: 23:00~01:00)
                kst_mins >= evening_start_mins || kst_mins < notif_end_mins
            } else {
                kst_mins >= evening_start_mins && kst_mins < notif_end_mins
            }
        }
        _ => false,
    };

    if !in_window {
        return NotificationDecision { send: false, message: None };
    }

    // 쓰로틀링
    let interval_secs = config.notification_interval_mins as u64 * 60;
    let throttled = match secs_since_last {
        Some(elapsed) => elapsed < interval_secs,
        None => false, // 첫 알림
    };

    if throttled {
        return NotificationDecision { send: false, message: None };
    }

    let (title, body) = notification_message(phase, remaining);
    NotificationDecision {
        send: true,
        message: Some((title, body)),
    }
}

/// 적응형 틱 간격 계산 (순수 함수).
pub(crate) fn compute_tick_interval(
    data_loaded: bool,
    needs_login: bool,
    attendance_open: bool,
    login_retry_active: bool,
    phase: DailyPhase,
    remaining: Option<i64>,
) -> u64 {
    let base_interval = if !data_loaded {
        5
    } else if needs_login {
        if attendance_open || login_retry_active {
            10
        } else {
            600
        }
    } else {
        match phase {
            DailyPhase::NeedStart | DailyPhase::StartOverdue | DailyPhase::NeedEnd => TICK_INTERVAL_ACTIVE,
            _ => TICK_INTERVAL_IDLE,
        }
    };

    if let Some(secs) = remaining {
        let secs = secs as u64;
        if secs > 0 && secs < base_interval {
            secs + 1
        } else {
            base_interval
        }
    } else {
        base_interval
    }
}

/// phase와 남은 시간으로 알림 제목·본문 생성.
pub(crate) fn notification_message(phase: DailyPhase, remaining: Option<i64>) -> (&'static str, String) {
    let format_remaining = |secs: i64| {
        let mins = secs / 60;
        if mins >= 60 {
            format!("마감까지 {}시간 {}분 남았습니다.", mins / 60, mins % 60)
        } else {
            format!("마감까지 {}분 남았습니다.", mins)
        }
    };

    match phase {
        DailyPhase::NeedStart => (
            "출석 체크 시간입니다",
            remaining.map(&format_remaining).unwrap_or_else(|| "출석 체크를 해주세요.".into()),
        ),
        DailyPhase::StartOverdue => ("출석 체크 지각!", "빨리 체크인하세요.".into()),
        DailyPhase::NeedEnd => (
            "학습 종료 체크가 필요합니다",
            remaining.map(&format_remaining).unwrap_or_else(|| "학습 종료 체크를 해주세요.".into()),
        ),
        _ => ("Jungle Bell", "출석 상태를 확인하세요.".into()),
    }
}

/// 스케줄러 틱 한 번의 순수 계산.
///
/// 상태를 갱신하고, 부수효과 지시를 `TickResult`로 반환.
/// 실제 부수효과(tray 갱신, 알림 발송, WebView 리로드)는 호출자가 수행.
pub(crate) fn compute_tick(
    state: &mut AppState,
    now: DateTime<Utc>,
    attendance_open: bool,
) -> TickResult {
    let kst_now = now.with_timezone(&kst());

    // --- 일일 리셋 ---
    let daily_reset = check_daily_reset(state, kst_now);

    // --- 상태 계산 ---
    let mut remaining: Option<i64> = None;
    let mut phase_changed = false;
    let mut notification = None;
    let mut tray_update = None;

    if state.data_loaded {
        let (phase, rem) = state::compute_daily_phase(
            &state.config, now, state.morning_checked, state.evening_checked,
        );
        remaining = rem;
        phase_changed = phase != state.phase;
        state.phase = phase;

        tray_update = Some((phase, remaining, state.needs_login));

        // --- 네이티브 알림 ---
        let secs_since_last = state.last_notification.map(|last| {
            (now - last).num_seconds().max(0) as u64
        });
        let decision = should_notify(
            &state.config, phase, remaining, state.needs_login, kst_now, secs_since_last,
        );
        if decision.send {
            if let Some(msg) = decision.message {
                notification = Some(msg);
                state.last_notification = Some(now);
            }
        }
    }

    // --- 체커 WebView 주기적 리로드 ---
    // API 호출은 WebView 쿠키를 사용하므로 세션/토큰 갱신을 위해
    // 주기적으로 출석 페이지로 다시 이동시킴 (15분 간격).
    // needs_login 상태에서도 리로드하여 사용자가 attendance 창에서
    // 로그인한 경우 세션이 자동 복구되도록 함.
    // 리로드 시 checker.js가 자동으로 initial check를 수행하므로
    // trigger_check를 건너뛰어 "Load failed" 레이스 컨디션을 방지.
    let should_reload = match state.last_reload {
        Some(last) => (now - last).num_seconds() as u64 >= RELOAD_INTERVAL_NORMAL,
        None => {
            state.last_reload = Some(now);
            false
        }
    };
    if should_reload {
        state.last_reload = Some(now);
    }

    // --- 로그인 재시도 윈도우 만료 확인 ---
    if let Some(until) = state.login_retry_until {
        if now >= until {
            state.login_retry_until = None;
        }
    }

    // --- 적응형 틱 간격 ---
    let login_retry_active = state.login_retry_until.is_some();
    let tick_interval = compute_tick_interval(
        state.data_loaded, state.needs_login, attendance_open,
        login_retry_active, state.phase, remaining,
    );

    TickResult {
        tick_interval,
        should_reload,
        phase_changed,
        notification,
        tray_update,
        daily_reset,
    }
}

/// 백그라운드 스케줄러 루프 시작.
pub fn start_scheduler(app_handle: tauri::AppHandle, shared_state: Arc<Mutex<AppState>>) {
    tauri::async_runtime::spawn(async move {
        {
            let s = shared_state.lock().await;
            info!(
                "[scheduler] config: day_start={:02}:{:02} start_deadline={:02}:{:02} end_open={:02}:{:02} day_end={:02}:{:02}",
                s.config.morning_start.hour,
                s.config.morning_start.minute,
                s.config.morning_end.hour,
                s.config.morning_end.minute,
                s.config.evening_start.hour,
                s.config.evening_start.minute,
                s.config.evening_end.hour,
                s.config.evening_end.minute,
            );
        }
        loop {
            let tick_result = {
                let now = Utc::now();
                let mut s = shared_state.lock().await;
                let attendance_open = app_handle.get_webview_window("attendance").is_some();

                let result = compute_tick(&mut s, now, attendance_open);

                if result.daily_reset {
                    let kst_now = now.with_timezone(&kst());
                    info!("[scheduler] daily reset at KST={}", kst_now.format("%Y-%m-%d %H:%M:%S"));
                }

                if result.phase_changed {
                    info!(
                        "[scheduler] phase={:?} started={} ended={} remaining={:?} needs_login={}",
                        s.phase, s.morning_checked, s.evening_checked,
                        result.tray_update.as_ref().map(|t| t.1).flatten(),
                        s.needs_login,
                    );
                }

                debug!(
                    "[scheduler] state: phase={:?} morning_checked={} evening_checked={} \
                     needs_login={} data_loaded={} kst={}",
                    s.phase, s.morning_checked, s.evening_checked,
                    s.needs_login, s.data_loaded,
                    now.with_timezone(&kst()).format("%Y-%m-%d %H:%M:%S"),
                );

                // --- 부수효과 ---
                if let Some((phase, remaining, needs_login)) = result.tray_update {
                    tray::update_tray(&app_handle, phase, remaining, needs_login);
                }

                if let Some((title, body)) = &result.notification {
                    let _ = app_handle.notification().builder().title(*title).body(body).show();
                    info!("[scheduler] notification sent: phase={:?}", s.phase);
                }

                if result.phase_changed {
                    let _ = tauri::Emitter::emit(&app_handle, "phase-changed", &s.phase);
                }

                if result.should_reload {
                    if let Some(checker) = app_handle.get_webview_window("checker") {
                        info!("[checker] webview reloaded for session refresh");
                        let _ = checker.navigate("https://jungle-lms.krafton.com/check-in".parse().unwrap());
                    }
                }

                result
            };

            debug!(
                "[scheduler] tick: interval={}s",
                tick_result.tick_interval,
            );

            // Rust가 오케스트레이터: 매 틱마다 JS 스냅샷 수집을 트리거.
            // 결과는 report_attendance_status 커맨드를 통해 비동기로 돌아온다.
            // 리로드한 틱에서는 건너뜀 — 새 페이지의 checker.js가 initial check를 수행.
            if !tick_result.should_reload {
                checker::trigger_check(&app_handle);
            }

            tokio::time::sleep(tokio::time::Duration::from_secs(tick_result.tick_interval)).await;
        }
    });
}

#[cfg(test)]
#[path = "tests/scheduler_tests.rs"]
mod tests;
