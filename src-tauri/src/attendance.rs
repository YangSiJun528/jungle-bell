//! 출석 도메인 순수 로직.
//!
//! WebView/IPC/Tauri side effect 없이 AttendanceReport 적용, phase 계산,
//! tray snapshot 생성을 담당한다.

use std::collections::BTreeSet;

use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Deserializer, Serialize};

use crate::state::{self, AppState, CheckerRuntimeStatus, CohortPeriod, DailyPhase, DdayStatus, TraySnapshot};

/// checker.js의 API 조회 결과.
/// JS invoke 호출의 JSON 페이로드에서 역직렬화됨.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AttendanceReport {
    /// 현재 checker WebView page-load generation.
    pub generation: u64,
    /// 로그인이 필요한 상태 (401 또는 로그인 페이지)
    pub needs_login: bool,
    /// 출석(체크인) 완료 여부
    pub morning_done: bool,
    /// 퇴실(체크아웃) 완료 여부
    pub evening_done: bool,
    /// API 호출 실패 여부 (true이면 출석 상태 갱신 건너뜀)
    pub api_error: bool,
    /// /api/v2/me/cohorts 기준 현재 코호트 상태.
    pub cohort_status: CohortReportStatus,
    /// 현재 코호트 시작일 (YYYY-MM-DD).
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub cohort_start_date: Option<String>,
    /// 현재 코호트 종료일 (YYYY-MM-DD).
    #[serde(deserialize_with = "deserialize_required_nullable")]
    pub cohort_end_date: Option<String>,
}

fn deserialize_required_nullable<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CohortReportStatus {
    Active,
    Upcoming,
    Ended,
    #[serde(rename = "none")]
    NoCohort,
    #[default]
    Unknown,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CohortOption {
    pub id: String,
    pub label: String,
    pub start_date: NaiveDate,
    pub end_date: Option<NaiveDate>,
    pub is_active: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct CohortResolution {
    pub cohort_id: Option<String>,
    pub cohort_status: CohortReportStatus,
    pub cohort_start_date: Option<NaiveDate>,
    pub cohort_end_date: Option<NaiveDate>,
}

fn validate_cohort_id(value: &str) -> Result<(), String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed != value || trimmed.chars().count() > 128 || trimmed.chars().any(char::is_control)
    {
        return Err("잘못된 기수 ID입니다.".into());
    }
    Ok(())
}

pub(crate) fn validate_cohort_options(options: &[CohortOption]) -> Result<(), String> {
    if options.len() > 32 {
        return Err("기수 목록이 허용 개수를 초과했습니다.".into());
    }

    let mut ids = BTreeSet::new();
    for option in options {
        validate_cohort_id(&option.id)?;
        let label = option.label.trim();
        if label.is_empty()
            || label != option.label
            || label.chars().count() > 80
            || label.chars().any(char::is_control)
        {
            return Err("잘못된 기수 이름입니다.".into());
        }
        if option.end_date.is_some_and(|end_date| end_date < option.start_date) {
            return Err("기수 종료일이 시작일보다 빠릅니다.".into());
        }
        if !ids.insert(option.id.as_str()) {
            return Err("중복된 기수 ID입니다.".into());
        }
    }
    Ok(())
}

fn cohort_resolution(option: &CohortOption, today: NaiveDate) -> CohortResolution {
    if option.end_date.is_some_and(|end_date| end_date < today) {
        return CohortResolution {
            cohort_id: None,
            cohort_status: CohortReportStatus::Ended,
            cohort_start_date: Some(option.start_date),
            cohort_end_date: option.end_date,
        };
    }
    if option.start_date > today {
        return CohortResolution {
            cohort_id: None,
            cohort_status: CohortReportStatus::Upcoming,
            cohort_start_date: Some(option.start_date),
            cohort_end_date: option.end_date,
        };
    }

    let in_range = option.end_date.is_none_or(|end_date| today <= end_date);
    CohortResolution {
        cohort_id: in_range.then(|| option.id.clone()),
        cohort_status: if in_range {
            CohortReportStatus::Active
        } else {
            CohortReportStatus::Unknown
        },
        cohort_start_date: in_range.then_some(option.start_date),
        cohort_end_date: in_range.then_some(option.end_date).flatten(),
    }
}

pub(crate) fn resolve_current_cohort(options: &[CohortOption], today: NaiveDate) -> CohortResolution {
    if let Some(active) = options
        .iter()
        .filter(|option| option.start_date <= today && option.end_date.is_some_and(|end_date| today <= end_date))
        .min_by(|left, right| {
            left.end_date
                .cmp(&right.end_date)
                .then_with(|| right.start_date.cmp(&left.start_date))
                .then_with(|| left.id.cmp(&right.id))
        })
    {
        return cohort_resolution(active, today);
    }
    if let Some(open_ended) = options
        .iter()
        .filter(|option| option.start_date <= today && option.end_date.is_none())
        .max_by(|left, right| {
            left.start_date
                .cmp(&right.start_date)
                .then_with(|| right.id.cmp(&left.id))
        })
    {
        return cohort_resolution(open_ended, today);
    }
    if let Some(upcoming) = options
        .iter()
        .filter(|option| option.start_date > today && option.end_date.is_some())
        .min_by(|left, right| {
            left.end_date
                .cmp(&right.end_date)
                .then_with(|| left.start_date.cmp(&right.start_date))
                .then_with(|| left.id.cmp(&right.id))
        })
    {
        return cohort_resolution(upcoming, today);
    }
    if let Some(upcoming) = options
        .iter()
        .filter(|option| option.start_date > today && option.end_date.is_none())
        .min_by(|left, right| {
            left.start_date
                .cmp(&right.start_date)
                .then_with(|| left.id.cmp(&right.id))
        })
    {
        return cohort_resolution(upcoming, today);
    }
    if let Some(ended) = options
        .iter()
        .filter(|option| option.end_date.is_some_and(|end_date| end_date < today))
        .max_by_key(|option| option.end_date)
    {
        return cohort_resolution(ended, today);
    }

    CohortResolution {
        cohort_id: None,
        cohort_status: if options.is_empty() {
            CohortReportStatus::NoCohort
        } else {
            CohortReportStatus::Unknown
        },
        cohort_start_date: None,
        cohort_end_date: None,
    }
}

pub(crate) fn resolve_cohort(
    options: &[CohortOption],
    selected_cohort_id: Option<&str>,
    today: NaiveDate,
) -> CohortResolution {
    if let Some(selected) = selected_cohort_id.and_then(|id| options.iter().find(|option| option.id == id)) {
        return cohort_resolution(selected, today);
    }
    resolve_current_cohort(options, today)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct AttendanceUpdate {
    pub(crate) phase: DailyPhase,
    pub(crate) remaining: Option<i64>,
}

fn parse_report_date(value: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(value, "%Y-%m-%d").ok()
}

fn cohort_period_from_report(report: &AttendanceReport) -> Option<CohortPeriod> {
    let start_date = report.cohort_start_date.as_deref().and_then(parse_report_date)?;
    let end_date = report.cohort_end_date.as_deref().and_then(parse_report_date)?;
    (start_date <= end_date).then_some(CohortPeriod { start_date, end_date })
}

fn dday_status_from_report(report: &AttendanceReport) -> DdayStatus {
    if report.needs_login {
        return DdayStatus::LoginRequired;
    }

    match report.cohort_status {
        CohortReportStatus::Active => match report.cohort_end_date.as_deref() {
            Some(value) => parse_report_date(value)
                .map(|end_date| DdayStatus::Active { end_date })
                .unwrap_or(DdayStatus::Unknown),
            None => DdayStatus::Unavailable,
        },
        CohortReportStatus::Upcoming => match report.cohort_end_date.as_deref() {
            Some(value) => parse_report_date(value)
                .map(|end_date| DdayStatus::Upcoming {
                    end_date: Some(end_date),
                })
                .unwrap_or(DdayStatus::Unknown),
            None => DdayStatus::Upcoming { end_date: None },
        },
        CohortReportStatus::Ended => DdayStatus::Ended,
        CohortReportStatus::NoCohort => DdayStatus::NoCohort,
        CohortReportStatus::Unknown => DdayStatus::Unknown,
    }
}

pub(crate) fn apply_report_fields(state: &mut AppState, report: &AttendanceReport) {
    state.data_loaded = true;

    if report.needs_login {
        state.needs_login = true;
        state.dday_status = DdayStatus::LoginRequired;
        state.cohort_period = None;
        return;
    }

    state.needs_login = false;
    state.morning_checked = report.morning_done;
    state.evening_checked = report.evening_done;
    state.dday_status = dday_status_from_report(report);
    state.cohort_period = cohort_period_from_report(report);
}

pub(crate) fn apply_dday_from_report(state: &mut AppState, report: &AttendanceReport) {
    let dday_status = dday_status_from_report(report);
    if !matches!(dday_status, DdayStatus::Unknown) {
        state.dday_status = dday_status;
        state.cohort_period = cohort_period_from_report(report);
    }
}

pub(crate) fn compute_phase_update(state: &mut AppState, now: DateTime<Utc>) -> Option<AttendanceUpdate> {
    if !state.data_loaded {
        return None;
    }

    if state.dday_status.suppress_attendance_phase() {
        state.phase = DailyPhase::Idle;
        return Some(AttendanceUpdate {
            phase: DailyPhase::Idle,
            remaining: None,
        });
    }

    let (phase, remaining) = state::compute_daily_phase(now, state.morning_checked, state.evening_checked);
    state.phase = phase;

    Some(AttendanceUpdate { phase, remaining })
}

/// 체커 보고를 앱 상태에 반영하고 phase를 재계산한다.
///
/// API 에러 시 `data_loaded`와 D-day 가능한 정보만 반영하고 `None`을 반환한다.
pub(crate) fn apply_attendance_report(
    state: &mut AppState,
    report: &AttendanceReport,
    now: DateTime<Utc>,
) -> Option<AttendanceUpdate> {
    if report.api_error {
        state.data_loaded = true;
        state.checker.status = CheckerRuntimeStatus::Offline {
            generation: state.checker.report_generation,
        };
        apply_dday_from_report(state, report);
        return None;
    }

    apply_report_fields(state, report);
    compute_phase_update(state, now)
}

pub(crate) fn build_tray_snapshot(state: &AppState, remaining: Option<i64>) -> TraySnapshot {
    state.tray_snapshot(remaining)
}

#[cfg(test)]
mod tests {
    use chrono::{FixedOffset, TimeZone, Utc};

    use crate::config::Config;
    use crate::state::{AppState, CheckerRuntimeStatus, DailyPhase, DdayStatus};

    use super::*;

    fn kst_time(h: u32, m: u32, s: u32) -> chrono::DateTime<Utc> {
        FixedOffset::east_opt(9 * 3600)
            .unwrap()
            .with_ymd_and_hms(2026, 3, 17, h, m, s)
            .unwrap()
            .with_timezone(&Utc)
    }

    #[test]
    fn attendance_report는_phase와_tray_snapshot을_만든다() {
        let mut state = AppState::new(Config::default());
        state.checker.status = CheckerRuntimeStatus::Healthy { generation: 1 };
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

        let update = apply_attendance_report(&mut state, &report, kst_time(12, 0, 0)).unwrap();
        let snapshot = build_tray_snapshot(&state, update.remaining);

        assert_eq!(update.phase, DailyPhase::Studying);
        assert_eq!(snapshot.phase, DailyPhase::Studying);
        assert!(snapshot.data_loaded);
        assert!(!snapshot.needs_login);
        assert_eq!(
            snapshot.dday_status,
            DdayStatus::Active {
                end_date: chrono::NaiveDate::from_ymd_opt(2026, 3, 31).unwrap(),
            }
        );
        assert_eq!(
            snapshot.cohort_period,
            Some(state::CohortPeriod {
                start_date: chrono::NaiveDate::from_ymd_opt(2026, 3, 1).unwrap(),
                end_date: chrono::NaiveDate::from_ymd_opt(2026, 3, 31).unwrap(),
            })
        );
    }

    #[test]
    fn login_required_report는_로그인필요_snapshot을_만든다() {
        let mut state = AppState::new(Config::default());
        state.checker.status = CheckerRuntimeStatus::Healthy { generation: 1 };
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

        let update = apply_attendance_report(&mut state, &report, kst_time(9, 0, 0)).unwrap();
        let snapshot = build_tray_snapshot(&state, update.remaining);

        assert_eq!(update.phase, DailyPhase::NeedStart);
        assert!(snapshot.needs_login);
        assert_eq!(snapshot.dday_status, DdayStatus::LoginRequired);
    }

    #[test]
    fn 진행중인_기수에_종료일이_없으면_dday_정보없음으로_구분한다() {
        let mut state = AppState::new(Config::default());
        state.checker.status = CheckerRuntimeStatus::Healthy { generation: 1 };
        let report = AttendanceReport {
            generation: 1,
            needs_login: false,
            morning_done: true,
            evening_done: false,
            api_error: false,
            cohort_status: CohortReportStatus::Active,
            cohort_start_date: Some("2026-03-01".into()),
            cohort_end_date: None,
        };

        let update = apply_attendance_report(&mut state, &report, kst_time(12, 0, 0)).unwrap();

        assert_eq!(update.phase, DailyPhase::Studying);
        assert_eq!(state.dday_status, DdayStatus::Unavailable);
    }

    fn cohort(id: &str, label: &str, start_date: (i32, u32, u32), end_date: (i32, u32, u32)) -> CohortOption {
        CohortOption {
            id: id.into(),
            label: label.into(),
            start_date: chrono::NaiveDate::from_ymd_opt(start_date.0, start_date.1, start_date.2).unwrap(),
            end_date: Some(chrono::NaiveDate::from_ymd_opt(end_date.0, end_date.1, end_date.2).unwrap()),
            is_active: true,
        }
    }

    #[test]
    fn 종료일이_가장_가까운_활성_기수를_자동_선택한다() {
        let options = vec![
            cohort("cohort-1", "1기", (2026, 3, 1), (2026, 8, 1)),
            cohort("cohort-2", "2기", (2026, 6, 1), (2026, 12, 31)),
        ];
        let today = chrono::NaiveDate::from_ymd_opt(2026, 7, 27).unwrap();

        let resolution = resolve_current_cohort(&options, today);

        assert_eq!(resolution.cohort_id.as_deref(), Some("cohort-1"));
        assert_eq!(resolution.cohort_status, CohortReportStatus::Active);
    }

    #[test]
    fn 활성_기수가_없으면_가장_가까운_미래_기수를_upcoming으로_선택한다() {
        let options = vec![cohort("cohort-future", "다음 기수", (2026, 8, 10), (2026, 12, 31))];
        let today = chrono::NaiveDate::from_ymd_opt(2026, 7, 27).unwrap();

        let resolution = resolve_current_cohort(&options, today);

        assert_eq!(resolution.cohort_id, None);
        assert_eq!(resolution.cohort_status, CohortReportStatus::Upcoming);
        assert_eq!(
            resolution.cohort_start_date,
            Some(chrono::NaiveDate::from_ymd_opt(2026, 8, 10).unwrap())
        );
        assert_eq!(
            resolution.cohort_end_date,
            Some(chrono::NaiveDate::from_ymd_opt(2026, 12, 31).unwrap())
        );
    }

    #[test]
    fn upcoming_기수는_출석을_요구하지_않고_dday는_유지한다() {
        let mut state = AppState::new(Config::default());
        state.checker.status = CheckerRuntimeStatus::Healthy { generation: 1 };
        let report = AttendanceReport {
            generation: 1,
            needs_login: false,
            morning_done: false,
            evening_done: false,
            api_error: false,
            cohort_status: CohortReportStatus::Upcoming,
            cohort_start_date: Some("2026-08-10".into()),
            cohort_end_date: Some("2026-12-31".into()),
        };

        let update = apply_attendance_report(&mut state, &report, kst_time(12, 0, 0)).unwrap();

        assert_eq!(update.phase, DailyPhase::Idle);
        assert_eq!(
            state.dday_status,
            DdayStatus::Upcoming {
                end_date: Some(chrono::NaiveDate::from_ymd_opt(2026, 12, 31).unwrap())
            }
        );
        assert_eq!(
            state.cohort_period,
            Some(state::CohortPeriod {
                start_date: chrono::NaiveDate::from_ymd_opt(2026, 8, 10).unwrap(),
                end_date: chrono::NaiveDate::from_ymd_opt(2026, 12, 31).unwrap(),
            })
        );
    }

    #[test]
    fn 원격_checker가_보낸_기수_목록은_개수와_문자열을_검증한다() {
        let valid = vec![cohort("cohort-1", "1기", (2026, 3, 1), (2026, 8, 1))];
        assert!(validate_cohort_options(&valid).is_ok());

        let duplicate = vec![valid[0].clone(), valid[0].clone()];
        assert!(validate_cohort_options(&duplicate).is_err());

        let forged = vec![CohortOption {
            label: "1기\n위조".into(),
            ..valid[0].clone()
        }];
        assert!(validate_cohort_options(&forged).is_err());
    }
}
