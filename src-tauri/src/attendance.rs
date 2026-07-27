//! 출석 도메인 순수 로직.
//!
//! WebView/IPC/Tauri side effect 없이 AttendanceReport 적용, phase 계산,
//! 알림 판단, tray snapshot 생성을 담당한다.

use std::collections::BTreeSet;

use chrono::{DateTime, Datelike, FixedOffset, NaiveDate, Timelike, Utc, Weekday};
use serde::{Deserialize, Serialize};

use crate::attendance_day;
use crate::config::Config;
use crate::state::{self, AppState, CheckerRuntimeStatus, DailyPhase, DdayStatus, TraySnapshot};

/// checker.js의 API 조회 결과.
/// JS invoke 호출의 JSON 페이로드에서 역직렬화됨.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct AttendanceReport {
    /// checker WebView generation. 없는 payload는 0으로 처리해 기존 JS 초기 실행을 수용한다.
    #[serde(default)]
    pub generation: u64,
    /// 로그인이 필요한 상태 (401 또는 로그인 페이지)
    pub needs_login: bool,
    /// 출석(체크인) 완료 여부
    #[serde(default)]
    pub morning_done: bool,
    /// 퇴실(체크아웃) 완료 여부
    #[serde(default)]
    pub evening_done: bool,
    /// API 호출 실패 여부 (true이면 출석 상태 갱신 건너뜀)
    #[serde(default)]
    pub api_error: bool,
    /// /api/v2/me/cohorts 기준 현재 코호트 상태.
    #[serde(default)]
    pub cohort_status: CohortReportStatus,
    /// 현재 코호트 종료일 (YYYY-MM-DD).
    #[serde(default)]
    pub cohort_end_date: Option<String>,
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
    pub cohort_end_date: Option<NaiveDate>,
}

pub(crate) fn validate_cohort_options(options: &[CohortOption]) -> Result<(), String> {
    if options.len() > 32 {
        return Err("기수 목록이 허용 개수를 초과했습니다.".into());
    }

    let mut ids = BTreeSet::new();
    for option in options {
        crate::config::validate_cohort_id(&option.id)?;
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
            cohort_end_date: option.end_date,
        };
    }
    if option.start_date > today {
        return CohortResolution {
            cohort_id: None,
            cohort_status: CohortReportStatus::Upcoming,
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
        cohort_end_date: in_range.then_some(option.end_date).flatten(),
    }
}

pub(crate) fn resolve_cohort_selection(
    options: &[CohortOption],
    selected_cohort_id: Option<&str>,
    today: NaiveDate,
) -> CohortResolution {
    if let Some(selected) = selected_cohort_id.and_then(|id| options.iter().find(|option| option.id == id)) {
        return cohort_resolution(selected, today);
    }

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
        cohort_end_date: None,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct AttendanceUpdate {
    pub(crate) phase: DailyPhase,
    pub(crate) remaining: Option<i64>,
}

/// 알림 판단 결과.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct NotificationDecision {
    pub(crate) send: bool,
    pub(crate) reason: &'static str,
    pub(crate) message: Option<(&'static str, String)>,
}

fn parse_report_date(value: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(value, "%Y-%m-%d").ok()
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
        return;
    }

    state.needs_login = false;
    state.login_retry_until = None;
    state.morning_checked = report.morning_done;
    state.evening_checked = report.evening_done;
    state.dday_status = dday_status_from_report(report);
}

pub(crate) fn apply_dday_from_report(state: &mut AppState, report: &AttendanceReport) {
    let dday_status = dday_status_from_report(report);
    if !matches!(dday_status, DdayStatus::Unknown) {
        state.dday_status = dday_status;
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

    let (phase, remaining) =
        state::compute_daily_phase(&state.config, now, state.morning_checked, state.evening_checked);
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

pub(crate) fn notification_decision(
    config: &Config,
    phase: DailyPhase,
    remaining: Option<i64>,
    needs_login: bool,
    kst_now: DateTime<FixedOffset>,
) -> NotificationDecision {
    if needs_login {
        return NotificationDecision {
            send: false,
            reason: "needs_login",
            message: None,
        };
    }

    if config.skip_sunday && kst_now.weekday() == Weekday::Sun {
        return NotificationDecision {
            send: false,
            reason: "skip_sunday",
            message: None,
        };
    }

    if attendance_day::is_skip_attendance_active(config, kst_now) {
        return NotificationDecision {
            send: false,
            reason: "skip_attendance",
            message: None,
        };
    }

    let enabled = match phase {
        DailyPhase::NeedStart | DailyPhase::StartOverdue => config.start_notification_enabled,
        DailyPhase::NeedEnd => config.end_notification_enabled,
        _ => false,
    };
    if !enabled {
        return NotificationDecision {
            send: false,
            reason: "disabled",
            message: None,
        };
    }

    let kst_secs = (kst_now.hour() as i64) * 3600 + (kst_now.minute() as i64) * 60 + (kst_now.second() as i64);
    let notif_start_secs = config.notification_start.to_secs();
    let notif_end_secs = config.notification_end.to_secs();
    let evening_start_secs = config.evening_start.to_secs();

    let in_window = match phase {
        DailyPhase::NeedStart | DailyPhase::StartOverdue => kst_secs >= notif_start_secs,
        DailyPhase::NeedEnd => {
            if notif_end_secs <= evening_start_secs {
                kst_secs >= evening_start_secs || kst_secs < notif_end_secs
            } else {
                kst_secs >= evening_start_secs && kst_secs < notif_end_secs
            }
        }
        _ => false,
    };

    if !in_window {
        return NotificationDecision {
            send: false,
            reason: "outside_window",
            message: None,
        };
    }

    NotificationDecision {
        send: true,
        reason: "send",
        message: Some(notification_message(phase, remaining)),
    }
}

/// phase와 남은 시간으로 알림 제목·본문 생성.
pub(crate) fn notification_message(phase: DailyPhase, remaining: Option<i64>) -> (&'static str, String) {
    let format_remaining = |secs: i64| {
        let mins = (secs + 59) / 60;
        if mins >= 60 {
            format!("마감까지 {}시간 {}분 남았습니다.", mins / 60, mins % 60)
        } else {
            format!("마감까지 {}분 남았습니다.", mins)
        }
    };

    match phase {
        DailyPhase::NeedStart => (
            "출석 체크 시간입니다",
            remaining
                .map(&format_remaining)
                .unwrap_or_else(|| "출석 체크를 해주세요.".into()),
        ),
        DailyPhase::StartOverdue => match remaining {
            Some(r) if r > 0 => (
                "출석 체크 지각 임박!",
                format!("마감까지 {}분 남았습니다.", (r + 59) / 60),
            ),
            _ => ("출석 체크 지각!", "빨리 체크인하세요.".into()),
        },
        DailyPhase::NeedEnd => (
            "학습 종료 체크가 필요합니다",
            remaining
                .map(&format_remaining)
                .unwrap_or_else(|| "학습 종료 체크를 해주세요.".into()),
        ),
        _ => ("Jungle Bell", "출석 상태를 확인하세요.".into()),
    }
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
            cohort_end_date: None,
        };

        let update = apply_attendance_report(&mut state, &report, kst_time(12, 0, 0)).unwrap();

        assert_eq!(update.phase, DailyPhase::Studying);
        assert_eq!(state.dday_status, DdayStatus::Unavailable);
    }

    #[test]
    fn notification_decision은_로그인필요와_skip_day를_도메인에서_판단한다() {
        let mut config = Config::default();
        config.skip_attendance = Some("2026-03-17".into());
        let kst_now = kst_time(9, 30, 0).with_timezone(&crate::state::kst());

        let login = notification_decision(&config, DailyPhase::NeedStart, Some(3600), true, kst_now);
        let skipped = notification_decision(&config, DailyPhase::NeedStart, Some(3600), false, kst_now);

        assert_eq!(login.reason, "needs_login");
        assert!(!login.send);
        assert_eq!(skipped.reason, "skip_attendance");
        assert!(!skipped.send);
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
    fn 복수_기수는_사용자가_선택한_기수를_우선한다() {
        let options = vec![
            cohort("cohort-1", "1기", (2026, 3, 1), (2026, 8, 1)),
            cohort("cohort-2", "2기", (2026, 6, 1), (2026, 12, 31)),
        ];
        let today = chrono::NaiveDate::from_ymd_opt(2026, 7, 27).unwrap();

        let resolution = resolve_cohort_selection(&options, Some("cohort-1"), today);

        assert_eq!(resolution.cohort_id.as_deref(), Some("cohort-1"));
        assert_eq!(resolution.cohort_status, CohortReportStatus::Active);
        assert_eq!(
            resolution.cohort_end_date,
            Some(chrono::NaiveDate::from_ymd_opt(2026, 8, 1).unwrap())
        );
    }

    #[test]
    fn 기수_선택이_없으면_종료일이_가장_가까운_활성_기수를_자동_선택한다() {
        let options = vec![
            cohort("cohort-1", "1기", (2026, 3, 1), (2026, 8, 1)),
            cohort("cohort-2", "2기", (2026, 6, 1), (2026, 12, 31)),
        ];
        let today = chrono::NaiveDate::from_ymd_opt(2026, 7, 27).unwrap();

        let resolution = resolve_cohort_selection(&options, None, today);

        assert_eq!(resolution.cohort_id.as_deref(), Some("cohort-1"));
        assert_eq!(resolution.cohort_status, CohortReportStatus::Active);
    }

    #[test]
    fn 저장한_기수가_목록에서_사라지면_자동_선택으로_fallback한다() {
        let options = vec![
            cohort("cohort-1", "1기", (2026, 3, 1), (2026, 8, 1)),
            cohort("cohort-2", "2기", (2026, 6, 1), (2026, 12, 31)),
        ];
        let today = chrono::NaiveDate::from_ymd_opt(2026, 7, 27).unwrap();

        let resolution = resolve_cohort_selection(&options, Some("removed-cohort"), today);

        assert_eq!(resolution.cohort_id.as_deref(), Some("cohort-1"));
        assert_eq!(resolution.cohort_status, CohortReportStatus::Active);
    }

    #[test]
    fn 미래_기수를_선택하면_upcoming으로_구분하고_종료일을_유지한다() {
        let options = vec![cohort("cohort-future", "다음 기수", (2026, 8, 10), (2026, 12, 31))];
        let today = chrono::NaiveDate::from_ymd_opt(2026, 7, 27).unwrap();

        let resolution = resolve_cohort_selection(&options, Some("cohort-future"), today);

        assert_eq!(resolution.cohort_id, None);
        assert_eq!(resolution.cohort_status, CohortReportStatus::Upcoming);
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
