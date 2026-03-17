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
use tokio::time::Instant;

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
    match phase {
        DailyPhase::NeedStart => {
            let body = if let Some(secs) = remaining {
                let mins = secs / 60;
                if mins >= 60 {
                    format!("마감까지 {}시간 {}분 남았습니다.", mins / 60, mins % 60)
                } else {
                    format!("마감까지 {}분 남았습니다.", mins)
                }
            } else {
                "출석 체크를 해주세요.".into()
            };
            ("출석 체크 시간입니다", body)
        }
        DailyPhase::StartOverdue => ("출석 체크 지각!", "빨리 체크인하세요.".into()),
        DailyPhase::NeedEnd => {
            let body = if let Some(secs) = remaining {
                let mins = secs / 60;
                if mins >= 60 {
                    format!("마감까지 {}시간 {}분 남았습니다.", mins / 60, mins % 60)
                } else {
                    format!("마감까지 {}분 남았습니다.", mins)
                }
            } else {
                "학습 종료 체크를 해주세요.".into()
            };
            ("학습 종료 체크가 필요합니다", body)
        }
        _ => ("Jungle Bell", "출석 상태를 확인하세요.".into()),
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
            let tick_secs = {
                let now = Utc::now();
                let kst_now = now.with_timezone(&kst());
                let mut s = shared_state.lock().await;

                // --- 일일 리셋 ---
                if check_daily_reset(&mut s, kst_now) {
                    info!("[scheduler] daily reset at KST={}", kst_now.format("%Y-%m-%d %H:%M:%S"));
                }

                // --- 상태 계산 ---
                // 체커의 첫 보고가 올 때까지 건너뜀.
                let mut remaining: Option<i64> = None;
                if s.data_loaded {
                    let (phase, rem) = state::compute_daily_phase(&s.config, now, s.morning_checked, s.evening_checked);
                    remaining = rem;

                    let phase_changed = phase != s.phase;

                    if phase_changed {
                        info!(
                            "[scheduler] phase={:?} started={} ended={} remaining={:?} needs_login={}",
                            phase, s.morning_checked, s.evening_checked, remaining, s.needs_login,
                        );
                    }

                    debug!(
                        "[scheduler] state: phase={:?} morning_checked={} evening_checked={} \
                         needs_login={} data_loaded={} remaining={:?} kst={}",
                        phase,
                        s.morning_checked,
                        s.evening_checked,
                        s.needs_login,
                        s.data_loaded,
                        remaining,
                        kst_now.format("%Y-%m-%d %H:%M:%S"),
                    );

                    s.phase = phase;

                    tray::update_tray(&app_handle, phase, remaining, s.needs_login);

                    // --- 네이티브 알림 ---
                    let secs_since_last = s.last_notification.map(|last| last.elapsed().as_secs());
                    let decision = should_notify(&s.config, phase, remaining, s.needs_login, kst_now, secs_since_last);
                    if decision.send {
                        if let Some((title, body)) = decision.message {
                            let _ = app_handle.notification().builder().title(title).body(body).show();
                            s.last_notification = Some(Instant::now());
                            info!("[scheduler] notification sent: phase={:?}", phase);
                        }
                    }

                    // 프론트엔드 창이 상태 변화에 반응할 수 있도록 이벤트 발행
                    if phase_changed {
                        let _ = tauri::Emitter::emit(&app_handle, "phase-changed", &phase);
                    }
                }

                // --- 체커 WebView 주기적 리로드 ---
                {
                    let now = Instant::now();
                    let should_reload = match s.last_reload {
                        Some(last) => {
                            now.duration_since(last) >= std::time::Duration::from_secs(RELOAD_INTERVAL_NORMAL)
                        }
                        None => {
                            s.last_reload = Some(now);
                            false
                        }
                    };
                    if should_reload {
                        s.last_reload = Some(now);
                        if let Some(checker) = app_handle.get_webview_window("checker") {
                            info!("[checker] webview reloaded for session refresh");
                            let _ = checker.navigate("https://jungle-lms.krafton.com/check-in".parse().unwrap());
                        }
                    }
                }

                // --- 로그인 재시도 윈도우 만료 확인 ---
                if let Some(until) = s.login_retry_until {
                    if Instant::now() >= until {
                        s.login_retry_until = None;
                        debug!("[scheduler] login retry window expired");
                    }
                }

                // --- 적응형 틱 간격 ---
                let attendance_open = app_handle.get_webview_window("attendance").is_some();
                let login_retry_active = s.login_retry_until.is_some();
                compute_tick_interval(s.data_loaded, s.needs_login, attendance_open, login_retry_active, s.phase, remaining)
            };

            {
                let s = shared_state.lock().await;
                debug!(
                    "[scheduler] tick: interval={}s phase={:?} needs_login={} data_loaded={}",
                    tick_secs, s.phase, s.needs_login, s.data_loaded,
                );
            }

            // Rust가 오케스트레이터: 매 틱마다 JS 스냅샷 수집을 트리거.
            checker::trigger_check(&app_handle);

            tokio::time::sleep(tokio::time::Duration::from_secs(tick_secs)).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use crate::config::Config;

    fn kst_dt(h: u32, m: u32, s: u32) -> DateTime<FixedOffset> {
        FixedOffset::east_opt(9 * 3600)
            .unwrap()
            .with_ymd_and_hms(2026, 3, 17, h, m, s)
            .unwrap()
    }

    fn default_state() -> AppState {
        AppState::new(Config::default())
    }

    // --- check_daily_reset ---

    #[test]
    fn daily_reset_first_call_sets_day() {
        let mut state = default_state();
        assert!(state.last_reset_day.is_none());
        let reset = check_daily_reset(&mut state, kst_dt(9, 0, 0));
        assert!(!reset);
        assert!(state.last_reset_day.is_some());
    }

    #[test]
    fn daily_reset_same_day_no_reset() {
        let mut state = default_state();
        let kst = kst_dt(9, 0, 0);
        check_daily_reset(&mut state, kst);
        state.morning_checked = true;
        state.evening_checked = true;

        let reset = check_daily_reset(&mut state, kst);
        assert!(!reset);
        assert!(state.morning_checked);
    }

    #[test]
    fn daily_reset_next_day_after_morning_start() {
        let mut state = default_state();
        let day1 = kst_dt(9, 0, 0);
        check_daily_reset(&mut state, day1);
        state.morning_checked = true;
        state.evening_checked = true;

        // 다음 날 05:00 (morning_start=04:00 이후)
        let day2 = FixedOffset::east_opt(9 * 3600)
            .unwrap()
            .with_ymd_and_hms(2026, 3, 18, 5, 0, 0)
            .unwrap();
        let reset = check_daily_reset(&mut state, day2);
        assert!(reset);
        assert!(!state.morning_checked);
        assert!(!state.evening_checked);
    }

    #[test]
    fn daily_reset_next_day_before_morning_start_no_reset() {
        let mut state = default_state();
        let day1 = kst_dt(9, 0, 0);
        check_daily_reset(&mut state, day1);
        state.morning_checked = true;

        // 다음 날 02:00 (morning_start=04:00 이전)
        let day2 = FixedOffset::east_opt(9 * 3600)
            .unwrap()
            .with_ymd_and_hms(2026, 3, 18, 2, 0, 0)
            .unwrap();
        let reset = check_daily_reset(&mut state, day2);
        assert!(!reset);
        assert!(state.morning_checked);
    }

    // --- should_notify ---

    #[test]
    fn notify_disabled() {
        let mut config = Config::default();
        config.notification_enabled = false;
        let d = should_notify(&config, DailyPhase::NeedStart, Some(3600), false, kst_dt(9, 30, 0), None);
        assert!(!d.send);
    }

    #[test]
    fn notify_needs_login() {
        let config = Config::default();
        let d = should_notify(&config, DailyPhase::NeedStart, Some(3600), true, kst_dt(9, 30, 0), None);
        assert!(!d.send);
    }

    #[test]
    fn notify_non_actionable_phase() {
        let config = Config::default();
        let d = should_notify(&config, DailyPhase::Studying, Some(3600), false, kst_dt(12, 0, 0), None);
        assert!(!d.send);
    }

    #[test]
    fn notify_before_window() {
        let config = Config::default(); // notification_start=09:00
        // KST 08:00 — 아침 알림 윈도우 전
        let d = should_notify(&config, DailyPhase::NeedStart, Some(7200), false, kst_dt(8, 0, 0), None);
        assert!(!d.send);
    }

    #[test]
    fn notify_in_window_first_time() {
        let config = Config::default(); // notification_start=09:00
        let d = should_notify(&config, DailyPhase::NeedStart, Some(3600), false, kst_dt(9, 30, 0), None);
        assert!(d.send);
        assert!(d.message.is_some());
    }

    #[test]
    fn notify_throttled() {
        let config = Config::default(); // interval=15분
        // 마지막 알림 5분 전 → 쓰로틀
        let d = should_notify(&config, DailyPhase::NeedStart, Some(3600), false, kst_dt(9, 30, 0), Some(300));
        assert!(!d.send);
    }

    #[test]
    fn notify_after_throttle_expires() {
        let config = Config::default(); // interval=15분=900초
        let d = should_notify(&config, DailyPhase::NeedStart, Some(3600), false, kst_dt(9, 30, 0), Some(901));
        assert!(d.send);
    }

    #[test]
    fn notify_evening_across_midnight() {
        let config = Config::default(); // evening_start=23:00, notification_end=01:00
        // KST 00:30 — 자정 넘긴 저녁 윈도우 내
        let kst_0030 = FixedOffset::east_opt(9 * 3600)
            .unwrap()
            .with_ymd_and_hms(2026, 3, 18, 0, 30, 0)
            .unwrap();
        let d = should_notify(&config, DailyPhase::NeedEnd, Some(12600), false, kst_0030, None);
        assert!(d.send);
    }

    #[test]
    fn notify_evening_after_window() {
        let config = Config::default(); // notification_end=01:00
        // KST 01:30 — 윈도우 밖
        let kst_0130 = FixedOffset::east_opt(9 * 3600)
            .unwrap()
            .with_ymd_and_hms(2026, 3, 18, 1, 30, 0)
            .unwrap();
        let d = should_notify(&config, DailyPhase::NeedEnd, Some(9000), false, kst_0130, None);
        assert!(!d.send);
    }

    // --- compute_tick_interval ---

    #[test]
    fn tick_not_loaded() {
        assert_eq!(compute_tick_interval(false, false, false, false, DailyPhase::Idle, None), 5);
    }

    #[test]
    fn tick_needs_login_attendance_open() {
        assert_eq!(compute_tick_interval(true, true, true, false, DailyPhase::Idle, None), 10);
    }

    #[test]
    fn tick_needs_login_retry_active() {
        assert_eq!(compute_tick_interval(true, true, false, true, DailyPhase::Idle, None), 10);
    }

    #[test]
    fn tick_needs_login_no_retry() {
        assert_eq!(compute_tick_interval(true, true, false, false, DailyPhase::Idle, None), 600);
    }

    #[test]
    fn tick_active_phase() {
        assert_eq!(
            compute_tick_interval(true, false, false, false, DailyPhase::NeedStart, Some(3600)),
            TICK_INTERVAL_ACTIVE
        );
    }

    #[test]
    fn tick_idle_phase() {
        assert_eq!(
            compute_tick_interval(true, false, false, false, DailyPhase::Studying, Some(1800)),
            TICK_INTERVAL_IDLE
        );
    }

    #[test]
    fn tick_remaining_overrides_base() {
        // remaining=30 < base=60 → 31
        assert_eq!(
            compute_tick_interval(true, false, false, false, DailyPhase::NeedStart, Some(30)),
            31
        );
    }

    #[test]
    fn tick_remaining_zero_no_override() {
        assert_eq!(
            compute_tick_interval(true, false, false, false, DailyPhase::NeedStart, Some(0)),
            TICK_INTERVAL_ACTIVE
        );
    }

    // --- notification_message ---

    #[test]
    fn message_need_start_with_remaining() {
        let (title, body) = notification_message(DailyPhase::NeedStart, Some(5400));
        assert_eq!(title, "출석 체크 시간입니다");
        assert!(body.contains("1시간 30분"));
    }

    #[test]
    fn message_need_start_minutes_only() {
        let (_, body) = notification_message(DailyPhase::NeedStart, Some(1800));
        assert!(body.contains("30분"));
        assert!(!body.contains("시간"));
    }

    #[test]
    fn message_start_overdue() {
        let (title, body) = notification_message(DailyPhase::StartOverdue, None);
        assert_eq!(title, "출석 체크 지각!");
        assert!(body.contains("빨리"));
    }

    #[test]
    fn message_need_end() {
        let (title, _) = notification_message(DailyPhase::NeedEnd, Some(3600));
        assert_eq!(title, "학습 종료 체크가 필요합니다");
    }

    #[test]
    fn message_fallback() {
        let (title, _) = notification_message(DailyPhase::Idle, None);
        assert_eq!(title, "Jungle Bell");
    }
}
