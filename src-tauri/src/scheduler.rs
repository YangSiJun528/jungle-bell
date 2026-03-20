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
    if needs_login {
        return NotificationDecision { send: false, message: None };
    }

    // 시작/종료 출석별 알림 활성화 여부 확인
    let enabled = match phase {
        DailyPhase::NeedStart | DailyPhase::StartOverdue => config.start_notification_enabled,
        DailyPhase::NeedEnd => config.end_notification_enabled,
        _ => false,
    };
    if !enabled {
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
    let interval_mins = match phase {
        DailyPhase::NeedStart | DailyPhase::StartOverdue => config.start_notification_interval_mins,
        DailyPhase::NeedEnd => config.end_notification_interval_mins,
        _ => config.start_notification_interval_mins,
    };
    let interval_secs = interval_mins as u64 * 60;
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
        DailyPhase::StartOverdue => match remaining {
            Some(r) if r > 0 => ("출석 체크 지각 임박!", format!("마감까지 {}분 남았습니다.", r / 60)),
            _ => ("출석 체크 지각!", "빨리 체크인하세요.".into()),
        },
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

    /// KST 시각을 UTC DateTime으로 변환하는 헬퍼.
    fn kst_utc(h: u32, m: u32, s: u32) -> DateTime<Utc> {
        kst_dt(h, m, s).with_timezone(&Utc)
    }

    fn default_state() -> AppState {
        AppState::new(Config::default())
    }

    // --- check_daily_reset ---

    #[test]
    fn 첫_호출시_날짜가_설정되고_리셋은_발생하지_않는다() {
        // given
        let mut state = default_state();
        assert!(state.last_reset_day.is_none());

        // when
        let reset = check_daily_reset(&mut state, kst_dt(9, 0, 0));

        // then
        assert!(!reset);
        assert!(state.last_reset_day.is_some());
    }

    #[test]
    fn 같은_날에는_리셋이_발생하지_않는다() {
        // given
        let mut state = default_state();
        let kst = kst_dt(9, 0, 0);
        check_daily_reset(&mut state, kst);
        state.morning_checked = true;
        state.evening_checked = true;

        // when
        let reset = check_daily_reset(&mut state, kst);

        // then
        assert!(!reset);
        assert!(state.morning_checked);
    }

    #[test]
    fn 다음날_morning_start_이후에는_리셋이_발생한다() {
        // given
        let mut state = default_state();
        let day1 = kst_dt(9, 0, 0);
        check_daily_reset(&mut state, day1);
        state.morning_checked = true;
        state.evening_checked = true;

        // when: 다음 날 05:00 (morning_start=04:00 이후)
        let day2 = FixedOffset::east_opt(9 * 3600)
            .unwrap()
            .with_ymd_and_hms(2026, 3, 18, 5, 0, 0)
            .unwrap();
        let reset = check_daily_reset(&mut state, day2);

        // then
        assert!(reset);
        assert!(!state.morning_checked);
        assert!(!state.evening_checked);
    }

    #[test]
    fn 다음날_morning_start_이전에는_리셋이_발생하지_않는다() {
        // given
        let mut state = default_state();
        let day1 = kst_dt(9, 0, 0);
        check_daily_reset(&mut state, day1);
        state.morning_checked = true;

        // when: 다음 날 02:00 (morning_start=04:00 이전)
        let day2 = FixedOffset::east_opt(9 * 3600)
            .unwrap()
            .with_ymd_and_hms(2026, 3, 18, 2, 0, 0)
            .unwrap();
        let reset = check_daily_reset(&mut state, day2);

        // then
        assert!(!reset);
        assert!(state.morning_checked);
    }

    // --- should_notify ---

    #[test]
    fn 시작_알림_비활성화시_시작_알림을_보내지_않는다() {
        // given
        let mut config = Config::default();
        config.start_notification_enabled = false;

        // when
        let d = should_notify(&config, DailyPhase::NeedStart, Some(3600), false, kst_dt(9, 30, 0), None);

        // then
        assert!(!d.send);
    }

    #[test]
    fn 종료_알림_비활성화시_종료_알림을_보내지_않는다() {
        // given
        let mut config = Config::default();
        config.end_notification_enabled = false;

        // when: KST 23:30 — 저녁 윈도우 내
        let d = should_notify(&config, DailyPhase::NeedEnd, Some(3600), false, kst_dt(23, 30, 0), None);

        // then
        assert!(!d.send);
    }

    #[test]
    fn 시작_알림_비활성화시에도_종료_알림은_발송된다() {
        // given
        let mut config = Config::default();
        config.start_notification_enabled = false;

        // when: KST 23:30 — 저녁 윈도우 내
        let d = should_notify(&config, DailyPhase::NeedEnd, Some(3600), false, kst_dt(23, 30, 0), None);

        // then
        assert!(d.send);
    }

    #[test]
    fn 로그인_필요시_알림을_보내지_않는다() {
        // given
        let config = Config::default();

        // when
        let d = should_notify(&config, DailyPhase::NeedStart, Some(3600), true, kst_dt(9, 30, 0), None);

        // then
        assert!(!d.send);
    }

    #[test]
    fn 액션_불필요_페이즈에서는_알림을_보내지_않는다() {
        // given
        let config = Config::default();

        // when
        let d = should_notify(&config, DailyPhase::Studying, Some(3600), false, kst_dt(12, 0, 0), None);

        // then
        assert!(!d.send);
    }

    #[test]
    fn 알림_윈도우_이전에는_알림을_보내지_않는다() {
        // given: notification_start=09:00
        let config = Config::default();

        // when: KST 08:00 — 아침 알림 윈도우 전
        let d = should_notify(&config, DailyPhase::NeedStart, Some(7200), false, kst_dt(8, 0, 0), None);

        // then
        assert!(!d.send);
    }

    #[test]
    fn 알림_윈도우_내_첫_알림은_발송된다() {
        // given: notification_start=09:00
        let config = Config::default();

        // when
        let d = should_notify(&config, DailyPhase::NeedStart, Some(3600), false, kst_dt(9, 30, 0), None);

        // then
        assert!(d.send);
        assert!(d.message.is_some());
    }

    #[test]
    fn 쓰로틀_간격_내에는_알림을_보내지_않는다() {
        // given: interval=15분, 마지막 알림 5분 전
        let config = Config::default();

        // when
        let d = should_notify(&config, DailyPhase::NeedStart, Some(3600), false, kst_dt(9, 30, 0), Some(300));

        // then
        assert!(!d.send);
    }

    #[test]
    fn 쓰로틀_만료_후에는_알림이_발송된다() {
        // given: interval=15분=900초
        let config = Config::default();

        // when: 901초 경과
        let d = should_notify(&config, DailyPhase::NeedStart, Some(3600), false, kst_dt(9, 30, 0), Some(901));

        // then
        assert!(d.send);
    }

    #[test]
    fn 자정을_넘긴_저녁_윈도우_내에서_알림이_발송된다() {
        // given: evening_start=23:00, notification_end=01:00
        let config = Config::default();

        // when: KST 00:30 — 자정 넘긴 저녁 윈도우 내
        let kst_0030 = FixedOffset::east_opt(9 * 3600)
            .unwrap()
            .with_ymd_and_hms(2026, 3, 18, 0, 30, 0)
            .unwrap();
        let d = should_notify(&config, DailyPhase::NeedEnd, Some(12600), false, kst_0030, None);

        // then
        assert!(d.send);
    }

    #[test]
    fn 저녁_윈도우_종료_후에는_알림을_보내지_않는다() {
        // given: notification_end=01:00
        let config = Config::default();

        // when: KST 01:30 — 윈도우 밖
        let kst_0130 = FixedOffset::east_opt(9 * 3600)
            .unwrap()
            .with_ymd_and_hms(2026, 3, 18, 1, 30, 0)
            .unwrap();
        let d = should_notify(&config, DailyPhase::NeedEnd, Some(9000), false, kst_0130, None);

        // then
        assert!(!d.send);
    }

    // --- compute_tick_interval ---

    #[test]
    fn 데이터_미로드시_틱_간격은_5초이다() {
        // given & when
        let result = compute_tick_interval(false, false, false, false, DailyPhase::Idle, None);

        // then
        assert_eq!(result, 5);
    }

    #[test]
    fn 로그인_필요하고_출석_열려있으면_틱_간격은_10초이다() {
        // given & when
        let result = compute_tick_interval(true, true, true, false, DailyPhase::Idle, None);

        // then
        assert_eq!(result, 10);
    }

    #[test]
    fn 로그인_필요하고_재시도_활성화시_틱_간격은_10초이다() {
        // given & when
        let result = compute_tick_interval(true, true, false, true, DailyPhase::Idle, None);

        // then
        assert_eq!(result, 10);
    }

    #[test]
    fn 로그인_필요하고_재시도_없으면_틱_간격은_600초이다() {
        // given & when
        let result = compute_tick_interval(true, true, false, false, DailyPhase::Idle, None);

        // then
        assert_eq!(result, 600);
    }

    #[test]
    fn 액티브_페이즈에서_틱_간격은_활성_간격이다() {
        // given & when
        let result = compute_tick_interval(true, false, false, false, DailyPhase::NeedStart, Some(3600));

        // then
        assert_eq!(result, TICK_INTERVAL_ACTIVE);
    }

    #[test]
    fn 유휴_페이즈에서_틱_간격은_유휴_간격이다() {
        // given & when
        let result = compute_tick_interval(true, false, false, false, DailyPhase::Studying, Some(1800));

        // then
        assert_eq!(result, TICK_INTERVAL_IDLE);
    }

    #[test]
    fn 잔여시간이_기본_간격보다_짧으면_잔여시간_플러스_1이다() {
        // given & when: remaining=30 < base=60 → 31
        let result = compute_tick_interval(true, false, false, false, DailyPhase::NeedStart, Some(30));

        // then
        assert_eq!(result, 31);
    }

    #[test]
    fn 잔여시간이_0이면_기본_간격을_사용한다() {
        // given & when
        let result = compute_tick_interval(true, false, false, false, DailyPhase::NeedStart, Some(0));

        // then
        assert_eq!(result, TICK_INTERVAL_ACTIVE);
    }

    // --- notification_message ---

    #[test]
    fn 출석체크_필요시_시간_분_메시지를_생성한다() {
        let (title, body) = notification_message(DailyPhase::NeedStart, Some(5400));
        assert_eq!(title, "출석 체크 시간입니다");
        assert_eq!(body, "마감까지 1시간 30분 남았습니다.");
    }

    #[test]
    fn 출석체크_필요시_분만_있으면_시간을_표시하지_않는다() {
        let (title, body) = notification_message(DailyPhase::NeedStart, Some(1800));
        assert_eq!(title, "출석 체크 시간입니다");
        assert_eq!(body, "마감까지 30분 남았습니다.");
    }

    #[test]
    fn 출석체크_필요시_잔여시간_없으면_기본_메시지를_생성한다() {
        let (title, body) = notification_message(DailyPhase::NeedStart, None);
        assert_eq!(title, "출석 체크 시간입니다");
        assert_eq!(body, "출석 체크를 해주세요.");
    }

    #[test]
    fn 지각시_지각_메시지를_생성한다() {
        let (title, body) = notification_message(DailyPhase::StartOverdue, None);
        assert_eq!(title, "출석 체크 지각!");
        assert_eq!(body, "빨리 체크인하세요.");
    }

    #[test]
    fn 지각_임박시_임박_메시지를_생성한다() {
        let (title, body) = notification_message(DailyPhase::StartOverdue, Some(300));
        assert_eq!(title, "출석 체크 지각 임박!");
        assert_eq!(body, "마감까지 5분 남았습니다.");
    }

    #[test]
    fn 지각_잔여시간_0이면_지각_메시지를_생성한다() {
        let (title, body) = notification_message(DailyPhase::StartOverdue, Some(0));
        assert_eq!(title, "출석 체크 지각!");
        assert_eq!(body, "빨리 체크인하세요.");
    }

    #[test]
    fn 종료체크_필요시_종료_메시지를_생성한다() {
        let (title, body) = notification_message(DailyPhase::NeedEnd, Some(3600));
        assert_eq!(title, "학습 종료 체크가 필요합니다");
        assert_eq!(body, "마감까지 1시간 0분 남았습니다.");
    }

    #[test]
    fn 종료체크_시간_분_메시지를_생성한다() {
        let (title, body) = notification_message(DailyPhase::NeedEnd, Some(5400));
        assert_eq!(title, "학습 종료 체크가 필요합니다");
        assert_eq!(body, "마감까지 1시간 30분 남았습니다.");
    }

    #[test]
    fn 종료체크_분만_메시지를_생성한다() {
        let (title, body) = notification_message(DailyPhase::NeedEnd, Some(1800));
        assert_eq!(title, "학습 종료 체크가 필요합니다");
        assert_eq!(body, "마감까지 30분 남았습니다.");
    }

    #[test]
    fn 종료체크_잔여시간_없으면_기본_메시지를_생성한다() {
        let (title, body) = notification_message(DailyPhase::NeedEnd, None);
        assert_eq!(title, "학습 종료 체크가 필요합니다");
        assert_eq!(body, "학습 종료 체크를 해주세요.");
    }

    #[test]
    fn 기타_페이즈에서는_기본_메시지를_생성한다() {
        let (title, body) = notification_message(DailyPhase::Idle, None);
        assert_eq!(title, "Jungle Bell");
        assert_eq!(body, "출석 상태를 확인하세요.");
    }

    #[test]
    fn 학습중_페이즈에서는_기본_메시지를_생성한다() {
        let (title, body) = notification_message(DailyPhase::Studying, Some(3600));
        assert_eq!(title, "Jungle Bell");
        assert_eq!(body, "출석 상태를 확인하세요.");
    }

    #[test]
    fn 완료_페이즈에서는_기본_메시지를_생성한다() {
        let (title, body) = notification_message(DailyPhase::Complete, None);
        assert_eq!(title, "Jungle Bell");
        assert_eq!(body, "출석 상태를 확인하세요.");
    }

    #[test]
    fn 잔여시간_59초면_0분으로_표시한다() {
        let (_, body) = notification_message(DailyPhase::NeedStart, Some(59));
        assert_eq!(body, "마감까지 0분 남았습니다.");
    }

    #[test]
    fn 잔여시간_10시간이면_시간_분_형식으로_표시한다() {
        let (_, body) = notification_message(DailyPhase::NeedStart, Some(36000));
        assert_eq!(body, "마감까지 10시간 0분 남았습니다.");
    }

    // --- compute_tick (통합) ---

    #[test]
    fn 데이터_미로드시_트레이_알림_리로드_모두_없다() {
        // given
        let mut state = default_state();

        // when
        let result = compute_tick(&mut state, kst_utc(9, 0, 0), false);

        // then
        assert_eq!(result.tick_interval, 5);
        assert!(result.tray_update.is_none());
        assert!(result.notification.is_none());
        assert!(!result.should_reload);
    }

    #[test]
    fn 출석_필요_상태에서_알림_윈도우_내이면_알림이_발송된다() {
        // given
        let mut state = default_state();
        state.data_loaded = true;

        // when: 첫 틱, NeedStart + 알림 윈도우 내
        let result = compute_tick(&mut state, kst_utc(9, 30, 0), false);

        // then
        assert_eq!(state.phase, DailyPhase::NeedStart);
        assert!(result.tray_update.is_some());
        assert!(result.notification.is_some());
        assert!(state.last_notification.is_some());
    }

    #[test]
    fn 알림_쓰로틀_후_간격_경과시_재발송된다() {
        // given
        let mut state = default_state();
        state.data_loaded = true;
        compute_tick(&mut state, kst_utc(9, 30, 0), false);
        assert!(state.last_notification.is_some());

        // when: 5분 후 → 쓰로틀 (interval=15분)
        let result_5min = compute_tick(&mut state, kst_utc(9, 35, 0), false);

        // then: 쓰로틀됨
        assert!(result_5min.notification.is_none());

        // when: 16분 후 → 쓰로틀 해제
        let result_16min = compute_tick(&mut state, kst_utc(9, 46, 1), false);

        // then: 재발송
        assert!(result_16min.notification.is_some());
    }

    #[test]
    fn 학습중_상태에서는_알림이_발송되지_않는다() {
        // given
        let mut state = default_state();
        state.data_loaded = true;
        state.morning_checked = true;

        // when
        let result = compute_tick(&mut state, kst_utc(12, 0, 0), false);

        // then
        assert_eq!(state.phase, DailyPhase::Studying);
        assert!(result.notification.is_none());
        assert!(result.tray_update.is_some());
    }

    #[test]
    fn 리로드_간격_경과시_리로드가_발생한다() {
        // given
        let mut state = default_state();
        state.data_loaded = true;
        let t0 = kst_utc(9, 0, 0);
        let result = compute_tick(&mut state, t0, false);
        assert!(!result.should_reload);
        assert_eq!(state.last_reload, Some(t0));

        // when: 14분 후
        let t1 = kst_utc(9, 14, 0);
        let result_14min = compute_tick(&mut state, t1, false);

        // then: 아직 리로드 안 함
        assert!(!result_14min.should_reload);

        // when: 16분 후
        let t2 = kst_utc(9, 16, 0);
        let result_16min = compute_tick(&mut state, t2, false);

        // then: 리로드 발생
        assert!(result_16min.should_reload);
        assert_eq!(state.last_reload, Some(t2));
    }

    #[test]
    fn 로그인_재시도_만료시_틱_간격이_늘어난다() {
        // given
        let mut state = default_state();
        state.data_loaded = true;
        state.needs_login = true;
        let now = kst_utc(9, 0, 0);
        state.login_retry_until = Some(now + chrono::Duration::seconds(180));

        // when: 재시도 윈도우 내
        let result = compute_tick(&mut state, now, false);

        // then
        assert!(state.login_retry_until.is_some());
        assert_eq!(result.tick_interval, 10);

        // when: 4분 후 만료
        let later = kst_utc(9, 4, 0);
        let result = compute_tick(&mut state, later, false);

        // then
        assert!(state.login_retry_until.is_none());
        assert_eq!(result.tick_interval, 600);
    }

    #[test]
    fn 일일_리셋시_체크_상태가_초기화된다() {
        // given
        let mut state = default_state();
        state.data_loaded = true;
        state.morning_checked = true;
        state.evening_checked = true;
        compute_tick(&mut state, kst_utc(23, 0, 0), false);
        assert!(state.morning_checked);

        // when: Day 2 05:00 — 리셋
        let day2 = FixedOffset::east_opt(9 * 3600)
            .unwrap()
            .with_ymd_and_hms(2026, 3, 18, 5, 0, 0)
            .unwrap()
            .with_timezone(&Utc);
        let result = compute_tick(&mut state, day2, false);

        // then
        assert!(result.daily_reset);
        assert!(!state.morning_checked);
        assert!(!state.evening_checked);
    }

    #[test]
    fn 페이즈_변경시_변경_플래그가_설정된다() {
        // given
        let mut state = default_state();
        state.data_loaded = true;
        state.phase = DailyPhase::NeedStart;
        state.morning_checked = true;

        // when: 체크인 완료 → Studying
        let result = compute_tick(&mut state, kst_utc(12, 0, 0), false);

        // then
        assert!(result.phase_changed);
        assert_eq!(state.phase, DailyPhase::Studying);
    }

    // --- StartOverdue 유예 구간 ---

    #[test]
    fn 지각_임박_10시5분에는_remaining이_300이다() {
        // given: 10:05 KST, morning_end=10:00 → grace_remaining = 10:10 - 10:05 = 300초
        let config = Config::default();
        let now = kst_utc(10, 5, 0);

        // when
        let (phase, remaining) = state::compute_daily_phase(&config, now, false, false);

        // then
        assert_eq!(phase, DailyPhase::StartOverdue);
        assert_eq!(remaining, Some(300));
    }

    #[test]
    fn 지각_10시15분에는_remaining이_none이다() {
        // given: 10:15 KST, morning_end=10:00 → grace_remaining = 10:10 - 10:15 = -300 → None
        let config = Config::default();
        let now = kst_utc(10, 15, 0);

        // when
        let (phase, remaining) = state::compute_daily_phase(&config, now, false, false);

        // then
        assert_eq!(phase, DailyPhase::StartOverdue);
        assert_eq!(remaining, None);
    }

    #[test]
    fn 지각_정확히_10시10분에는_remaining이_none이다() {
        // given: 10:10:00 → grace_remaining = 0 → None
        let config = Config::default();
        let now = kst_utc(10, 10, 0);

        // when
        let (phase, remaining) = state::compute_daily_phase(&config, now, false, false);

        // then
        assert_eq!(phase, DailyPhase::StartOverdue);
        assert_eq!(remaining, None);
    }
}
