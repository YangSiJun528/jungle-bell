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

// --- compute_tick (통합) ---

#[test]
fn compute_tick_before_data_loaded() {
    let mut state = default_state();
    let result = compute_tick(&mut state, kst_utc(9, 0, 0), false);
    assert_eq!(result.tick_interval, 5);
    assert!(result.tray_update.is_none());
    assert!(result.notification.is_none());
    assert!(!result.should_reload);
}

#[test]
fn compute_tick_need_start_with_notification() {
    let mut state = default_state();
    state.data_loaded = true;

    // 첫 틱: NeedStart + 알림 윈도우 내 → 알림 발송
    let result = compute_tick(&mut state, kst_utc(9, 30, 0), false);
    assert_eq!(state.phase, DailyPhase::NeedStart);
    assert!(result.tray_update.is_some());
    assert!(result.notification.is_some());
    assert!(state.last_notification.is_some());
}

#[test]
fn compute_tick_notification_throttled() {
    let mut state = default_state();
    state.data_loaded = true;
    // 첫 틱: 알림 발송
    compute_tick(&mut state, kst_utc(9, 30, 0), false);
    assert!(state.last_notification.is_some());

    // 5분 후: 쓰로틀 (interval=15분)
    let result = compute_tick(&mut state, kst_utc(9, 35, 0), false);
    assert!(result.notification.is_none());

    // 16분 후: 쓰로틀 해제
    let result = compute_tick(&mut state, kst_utc(9, 46, 1), false);
    assert!(result.notification.is_some());
}

#[test]
fn compute_tick_studying_no_notification() {
    let mut state = default_state();
    state.data_loaded = true;
    state.morning_checked = true;

    let result = compute_tick(&mut state, kst_utc(12, 0, 0), false);
    assert_eq!(state.phase, DailyPhase::Studying);
    assert!(result.notification.is_none());
    assert!(result.tray_update.is_some());
}

#[test]
fn compute_tick_reload_after_interval() {
    let mut state = default_state();
    state.data_loaded = true;

    // 첫 틱: last_reload 초기화
    let t0 = kst_utc(9, 0, 0);
    let result = compute_tick(&mut state, t0, false);
    assert!(!result.should_reload);
    assert_eq!(state.last_reload, Some(t0));

    // 14분 후: 리로드 안 함
    let t1 = kst_utc(9, 14, 0);
    let result = compute_tick(&mut state, t1, false);
    assert!(!result.should_reload);

    // 16분 후: 리로드
    let t2 = kst_utc(9, 16, 0);
    let result = compute_tick(&mut state, t2, false);
    assert!(result.should_reload);
    assert_eq!(state.last_reload, Some(t2));
}

#[test]
fn compute_tick_login_retry_expires() {
    let mut state = default_state();
    state.data_loaded = true;
    state.needs_login = true;

    // 3분 후 만료되는 로그인 재시도 윈도우
    let now = kst_utc(9, 0, 0);
    state.login_retry_until = Some(now + chrono::Duration::seconds(180));

    let result = compute_tick(&mut state, now, false);
    assert!(state.login_retry_until.is_some());
    assert_eq!(result.tick_interval, 10); // login + retry active

    // 4분 후: 만료
    let later = kst_utc(9, 4, 0);
    let result = compute_tick(&mut state, later, false);
    assert!(state.login_retry_until.is_none());
    assert_eq!(result.tick_interval, 600); // login + no retry
}

#[test]
fn compute_tick_daily_reset() {
    let mut state = default_state();
    state.data_loaded = true;
    state.morning_checked = true;
    state.evening_checked = true;

    // Day 1
    compute_tick(&mut state, kst_utc(23, 0, 0), false);
    assert!(state.morning_checked);

    // Day 2 05:00 — 리셋
    let day2 = FixedOffset::east_opt(9 * 3600)
        .unwrap()
        .with_ymd_and_hms(2026, 3, 18, 5, 0, 0)
        .unwrap()
        .with_timezone(&Utc);
    let result = compute_tick(&mut state, day2, false);
    assert!(result.daily_reset);
    assert!(!state.morning_checked);
    assert!(!state.evening_checked);
}

#[test]
fn compute_tick_phase_change_detected() {
    let mut state = default_state();
    state.data_loaded = true;
    state.phase = DailyPhase::NeedStart;

    // 체크인 완료 → Studying
    state.morning_checked = true;
    let result = compute_tick(&mut state, kst_utc(12, 0, 0), false);
    assert!(result.phase_changed);
    assert_eq!(state.phase, DailyPhase::Studying);
}
