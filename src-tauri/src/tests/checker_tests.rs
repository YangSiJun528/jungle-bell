use super::*;
use chrono::{FixedOffset, TimeZone};
use crate::config::Config;

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
fn process_report_api_error_sets_data_loaded() {
    let mut state = default_state();
    let report = AttendanceReport {
        needs_login: false,
        morning_done: false,
        evening_done: false,
        api_error: true,
    };
    let result = process_report(&mut state, &report, kst_time(9, 0, 0));
    assert!(result.is_none());
    assert!(state.data_loaded);
}

#[test]
fn process_report_needs_login() {
    let mut state = default_state();
    let report = AttendanceReport {
        needs_login: true,
        morning_done: false,
        evening_done: false,
        api_error: false,
    };
    let result = process_report(&mut state, &report, kst_time(9, 0, 0));
    assert!(result.is_some());
    let (phase, remaining) = result.unwrap();
    // needs_login=true이지만 phase는 시간에 따라 계산됨
    assert_eq!(phase, DailyPhase::NeedStart);
    assert!(remaining.is_some());
    assert!(state.needs_login);
}

#[test]
fn process_report_morning_done() {
    let mut state = default_state();
    let report = AttendanceReport {
        needs_login: false,
        morning_done: true,
        evening_done: false,
        api_error: false,
    };
    // KST 12:00 — 체크인 완료, 체크아웃 전 → Studying
    let result = process_report(&mut state, &report, kst_time(12, 0, 0));
    let (phase, _) = result.unwrap();
    assert_eq!(phase, DailyPhase::Studying);
    assert!(state.morning_checked);
    assert!(!state.evening_checked);
}

#[test]
fn process_report_both_done() {
    let mut state = default_state();
    let report = AttendanceReport {
        needs_login: false,
        morning_done: true,
        evening_done: true,
        api_error: false,
    };
    let result = process_report(&mut state, &report, kst_time(23, 30, 0));
    let (phase, _) = result.unwrap();
    assert_eq!(phase, DailyPhase::Complete);
}

#[test]
fn process_report_checkin_overdue() {
    let mut state = default_state();
    let report = AttendanceReport {
        needs_login: false,
        morning_done: false,
        evening_done: false,
        api_error: false,
    };
    // KST 11:00 — morning_end(10:00) 지남, 미체크인 → StartOverdue
    let result = process_report(&mut state, &report, kst_time(11, 0, 0));
    let (phase, _) = result.unwrap();
    assert_eq!(phase, DailyPhase::StartOverdue);
}
