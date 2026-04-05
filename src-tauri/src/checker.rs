//! 체커 모듈 — API 기반 출석 상태 수신·처리.
//!
//! checker.js가 WebView에 주입되어 LMS REST API를 호출한다.
//! Rust가 `trigger_check()`로 이벤트를 발송하면,
//! JS가 API를 조회해 `report_attendance_status` invoke로 반환한다.
//! 이 모듈은 반환된 결과를 처리하고 공유 앱 상태를 갱신한다.

use serde::Deserialize;
use tauri::Emitter;

use chrono::{DateTime, Utc};

use crate::state::{self, AppState, DailyPhase};

/// checker.js의 API 조회 결과.
/// JS invoke 호출의 JSON 페이로드에서 역직렬화됨.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct AttendanceReport {
    /// 로그인이 필요한 상태 (401 또는 로그인 페이지)
    pub needs_login: bool,
    /// 출석(체크인) 완료 여부
    #[serde(default)]
    pub morning_done: bool,
    /// 퇴실(체크아웃) 완료 여부
    #[serde(default)]
    pub evening_done: bool,
    /// API 호출 실패 여부 (true이면 상태 갱신 건너뜀)
    #[serde(default)]
    pub api_error: bool,
}

/// 체커 보고를 공유 앱 상태에 반영.
pub fn apply_report(state: &mut AppState, report: &AttendanceReport) {
    state.data_loaded = true;

    if report.needs_login {
        state.needs_login = true;
        return;
    }

    state.needs_login = false;
    state.login_retry_until = None; // 로그인 성공 시 재시도 윈도우 해제
    state.morning_checked = report.morning_done;
    state.evening_checked = report.evening_done;
}

/// checker WebView에 trigger-check 이벤트를 발송.
/// JS가 이벤트를 수신하면 API를 조회해
/// `report_attendance_status` invoke로 반환한다.
pub fn trigger_check(app: &tauri::AppHandle) {
    log::debug!("[checker] trigger_check emitted");
    let _ = app.emit_to(
        tauri::EventTarget::WebviewWindow {
            label: "checker".into(),
        },
        "trigger-check",
        (),
    );
}

/// 순수 로직: 체커 보고를 앱 상태에 반영하고 phase를 재계산.
///
/// API 에러 시 `data_loaded`만 설정하고 `None` 반환.
/// 그 외에는 `apply_report` + `compute_daily_phase`를 수행하고
/// `Some((phase, remaining))` 반환.
pub(crate) fn process_report(
    state: &mut AppState,
    report: &AttendanceReport,
    now: DateTime<Utc>,
) -> Option<(DailyPhase, Option<i64>)> {
    if report.api_error {
        state.data_loaded = true;
        return None;
    }

    apply_report(state, report);

    let (phase, remaining) =
        state::compute_daily_phase(&state.config, now, state.morning_checked, state.evening_checked);
    state.phase = phase;
    Some((phase, remaining))
}

#[cfg(test)]
mod tests {
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
    fn api_에러시_데이터_로드_상태만_설정된다() {
        // given
        let mut state = default_state();
        let report = AttendanceReport {
            needs_login: false,
            morning_done: false,
            evening_done: false,
            api_error: true,
        };

        // when
        let result = process_report(&mut state, &report, kst_time(9, 0, 0));

        // then
        assert!(result.is_none());
        assert!(state.data_loaded);
    }

    #[test]
    fn 로그인_필요시_페이즈는_시간에_따라_계산된다() {
        // given
        let mut state = default_state();
        let report = AttendanceReport {
            needs_login: true,
            morning_done: false,
            evening_done: false,
            api_error: false,
        };

        // when
        let result = process_report(&mut state, &report, kst_time(9, 0, 0));

        // then
        assert!(result.is_some());
        let (phase, remaining) = result.unwrap();
        assert_eq!(phase, DailyPhase::NeedStart);
        assert!(remaining.is_some());
        assert!(state.needs_login);
    }

    #[test]
    fn 오전_출석_완료시_학습중_상태가_된다() {
        // given
        let mut state = default_state();
        let report = AttendanceReport {
            needs_login: false,
            morning_done: true,
            evening_done: false,
            api_error: false,
        };

        // when: KST 12:00 — 체크인 완료, 체크아웃 전
        let result = process_report(&mut state, &report, kst_time(12, 0, 0));

        // then
        let (phase, _) = result.unwrap();
        assert_eq!(phase, DailyPhase::Studying);
        assert!(state.morning_checked);
        assert!(!state.evening_checked);
    }

    #[test]
    fn 오전_오후_모두_완료시_완료_상태가_된다() {
        // given
        let mut state = default_state();
        let report = AttendanceReport {
            needs_login: false,
            morning_done: true,
            evening_done: true,
            api_error: false,
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
            needs_login: false,
            morning_done: false,
            evening_done: false,
            api_error: false,
        };

        // when: KST 11:00 — morning_end(10:00) 지남, 미체크인
        let result = process_report(&mut state, &report, kst_time(11, 0, 0));

        // then
        let (phase, _) = result.unwrap();
        assert_eq!(phase, DailyPhase::StartOverdue);
    }
}
