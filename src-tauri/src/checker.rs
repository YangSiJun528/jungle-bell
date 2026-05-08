//! 체커 모듈 — API 기반 출석 상태 수신·처리.
//!
//! checker.js가 WebView에 주입되어 LMS REST API를 호출한다.
//! Rust가 `trigger_check()`로 이벤트를 발송하면,
//! JS가 API를 조회해 `report_attendance_status` invoke로 반환한다.
//! 이 모듈은 반환된 결과를 처리하고 공유 앱 상태를 갱신한다.

use serde::Deserialize;
use tauri::{Emitter, Manager};

use chrono::{DateTime, NaiveDate, Utc};

use crate::state::{self, AppState, DailyPhase, DdayStatus};

const ATTENDANCE_URL: &str = "https://jungle-lms.krafton.com/check-in";

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
    /// /api/v2/me/cohorts 기준 현재 코호트 상태.
    #[serde(default)]
    pub cohort_status: CohortReportStatus,
    /// 현재 코호트 종료일 (YYYY-MM-DD).
    #[serde(default)]
    pub cohort_end_date: Option<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CohortReportStatus {
    Active,
    Ended,
    #[serde(rename = "none")]
    NoCohort,
    Unknown,
}

impl Default for CohortReportStatus {
    fn default() -> Self {
        Self::Unknown
    }
}

fn parse_report_date(value: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(value, "%Y-%m-%d").ok()
}

fn dday_status_from_report(report: &AttendanceReport) -> DdayStatus {
    if report.needs_login {
        return DdayStatus::LoginRequired;
    }

    match report.cohort_status {
        CohortReportStatus::Active => report
            .cohort_end_date
            .as_deref()
            .and_then(parse_report_date)
            .map(|end_date| DdayStatus::Active { end_date })
            .unwrap_or(DdayStatus::NoCohort),
        CohortReportStatus::Ended => DdayStatus::Ended,
        CohortReportStatus::NoCohort => DdayStatus::NoCohort,
        CohortReportStatus::Unknown => DdayStatus::Unknown,
    }
}

/// 체커 보고를 공유 앱 상태에 반영.
pub fn apply_report(state: &mut AppState, report: &AttendanceReport) {
    state.data_loaded = true;

    if report.needs_login {
        state.needs_login = true;
        state.dday_status = DdayStatus::LoginRequired;
        return;
    }

    state.needs_login = false;
    state.login_retry_until = None; // 로그인 성공 시 재시도 윈도우 해제
    state.morning_checked = report.morning_done;
    state.evening_checked = report.evening_done;
    state.dday_status = dday_status_from_report(report);
}

pub fn apply_dday_from_report(state: &mut AppState, report: &AttendanceReport) {
    let dday_status = dday_status_from_report(report);
    if !matches!(dday_status, DdayStatus::Unknown) {
        state.dday_status = dday_status;
    }
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

/// checker WebView를 출석 페이지 기준으로 갱신한다.
///
/// 이미 출석 페이지에 있으면 `navigate()` 대신 `reload()`를 사용한다.
/// 같은 URL로 `navigate()`하면 WebView가 page-load를 만들지 않을 수 있기 때문이다.
/// 로그인 페이지 등 다른 URL이면 출석 페이지로 이동시킨다.
pub fn refresh_webview(app: &tauri::AppHandle, reason: &str) -> bool {
    let Some(checker) = app.get_webview_window("checker") else {
        log::warn!("[checker] refresh skipped: checker window not found ({})", reason);
        return false;
    };

    let target = ATTENDANCE_URL.parse().unwrap();
    let current = checker.url().ok();
    let result = if current.as_ref().is_some_and(|url| same_url_without_trailing_slash(url.as_str(), ATTENDANCE_URL)) {
        log::info!("[checker] webview reloaded ({})", reason);
        checker.reload()
    } else {
        log::info!("[checker] webview navigated ({})", reason);
        checker.navigate(target)
    };

    match result {
        Ok(_) => true,
        Err(e) => {
            log::warn!("[checker] refresh failed ({}): {}", reason, e);
            false
        }
    }
}

fn same_url_without_trailing_slash(left: &str, right: &str) -> bool {
    left.trim_end_matches('/') == right.trim_end_matches('/')
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
        apply_dday_from_report(state, report);
        return None;
    }

    apply_report(state, report);

    if state.dday_status.suppress_attendance_phase() {
        state.phase = DailyPhase::Idle;
        return Some((DailyPhase::Idle, None));
    }

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
}
