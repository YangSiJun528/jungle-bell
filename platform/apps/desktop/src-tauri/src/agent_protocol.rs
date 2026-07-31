use std::collections::HashSet;

use serde::{Deserialize, Serialize};

const MAX_SUBJECT_BYTES: usize = 128;
const MAX_COHORT_ID_BYTES: usize = 128;
const MAX_NOTIFICATION_DELIVERIES: usize = 20;
const MAX_DELIVERY_ID_BYTES: usize = 128;
const MAX_EVENT_ID_BYTES: usize = 128;
const MAX_NOTIFICATION_TITLE_CHARS: usize = 120;
const MAX_NOTIFICATION_BODY_CHARS: usize = 1_024;
const MAX_NOTIFICATION_PATH_BYTES: usize = 512;
const MAX_NOTIFICATION_ATTEMPT: u32 = 100;

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(tag = "state")]
pub(crate) enum LmsAgentReport {
    #[serde(rename = "connected")]
    Connected(ConnectedAgentReport),
    #[serde(rename = "session-connected")]
    SessionConnected(SessionConnectedAgentReport),
    #[serde(rename = "login-required")]
    LoginRequired(LoginRequiredAgentReport),
    #[serde(rename = "collector-diagnostic")]
    CollectorDiagnostic(CollectorDiagnosticReport),
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SessionConnectedAgentReport {
    pub(crate) subject: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct LoginRequiredAgentReport {}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CollectorDiagnosticReport {
    pub(crate) stage: CollectorStage,
    pub(crate) reason: CollectorFailureReason,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum CollectorStage {
    Me,
    Cohorts,
    Attendance,
    Report,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum CollectorFailureReason {
    HttpUnavailable,
    InvalidPayload,
    RequestFailed,
    ReportRejected,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ConnectedAgentReport {
    pub(crate) subject: String,
    pub(crate) attendance_date: String,
    pub(crate) cohort_id: Option<String>,
    pub(crate) cohort_status: AttendanceCohortStatus,
    pub(crate) cohort_start_date: Option<String>,
    pub(crate) cohort_end_date: Option<String>,
    pub(crate) morning_checked: bool,
    pub(crate) evening_checked: bool,
    pub(crate) collected_at: String,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum AttendanceCohortStatus {
    Active,
    Upcoming,
    Ended,
    None,
    Unknown,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AttendanceSnapshotUpload {
    pub(crate) attendance_date: String,
    pub(crate) cohort_id: Option<String>,
    pub(crate) cohort_status: AttendanceCohortStatus,
    pub(crate) cohort_start_date: Option<String>,
    pub(crate) cohort_end_date: Option<String>,
    pub(crate) morning_checked: bool,
    pub(crate) evening_checked: bool,
    pub(crate) collected_at: String,
}

impl From<ConnectedAgentReport> for AttendanceSnapshotUpload {
    fn from(value: ConnectedAgentReport) -> Self {
        Self {
            attendance_date: value.attendance_date,
            cohort_id: value.cohort_id,
            cohort_status: value.cohort_status,
            cohort_start_date: value.cohort_start_date,
            cohort_end_date: value.cohort_end_date,
            morning_checked: value.morning_checked,
            evening_checked: value.evening_checked,
            collected_at: value.collected_at,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum LmsSessionState {
    Connected,
    LoginRequired,
    Unknown,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HeartbeatUpload<'a> {
    pub(crate) lms_session_state: LmsSessionState,
    pub(crate) app_version: Option<&'a str>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct NotificationPage {
    pub(crate) notifications: Vec<NotificationDelivery>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NotificationDelivery {
    pub(crate) delivery_id: String,
    pub(crate) event_id: String,
    pub(crate) kind: NotificationKind,
    pub(crate) title: String,
    pub(crate) body: String,
    pub(crate) path: String,
    pub(crate) created_at_epoch_ms: i64,
    pub(crate) attempt: u32,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum NotificationKind {
    MealPublished,
    LaundryFinishing,
    LaundryCompleted,
    LaundryAvailable,
    LaundryAttention,
    AttendanceActionRequired,
    LoginRequired,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum NotificationAckOutcome {
    Displayed,
    Failed,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NotificationAck {
    pub(crate) outcome: NotificationAckOutcome,
    pub(crate) occurred_at_epoch_ms: i64,
}

pub(crate) fn parse_agent_report(value: &str) -> Result<LmsAgentReport, String> {
    let report: LmsAgentReport =
        serde_json::from_str(value).map_err(|_| "LMS_AGENT_REPORT_INVALID".to_owned())?;
    validate_agent_report(&report)?;
    Ok(report)
}

pub(crate) fn validate_agent_report(report: &LmsAgentReport) -> Result<(), String> {
    match report {
        LmsAgentReport::LoginRequired(_) | LmsAgentReport::CollectorDiagnostic(_) => Ok(()),
        LmsAgentReport::SessionConnected(report) => validate_subject(&report.subject),
        LmsAgentReport::Connected(report) => validate_connected_report(report),
    }
}

fn validate_connected_report(report: &ConnectedAgentReport) -> Result<(), String> {
    validate_subject(&report.subject)?;
    if !is_date(&report.attendance_date) || !is_iso_timestamp(&report.collected_at) {
        return Err("LMS_AGENT_REPORT_INVALID".into());
    }

    for cohort_id in report.cohort_id.iter() {
        if !is_bounded_trimmed_text(cohort_id, 1, MAX_COHORT_ID_BYTES)
            || has_disallowed_control(cohort_id, false)
        {
            return Err("LMS_AGENT_REPORT_INVALID".into());
        }
    }
    for date in report
        .cohort_start_date
        .iter()
        .chain(report.cohort_end_date.iter())
    {
        if !is_date(date) {
            return Err("LMS_AGENT_REPORT_INVALID".into());
        }
    }
    if report
        .cohort_start_date
        .as_ref()
        .zip(report.cohort_end_date.as_ref())
        .is_some_and(|(start, end)| start > end)
    {
        return Err("LMS_AGENT_REPORT_INVALID".into());
    }

    let status_valid = match report.cohort_status {
        AttendanceCohortStatus::Active => {
            report.cohort_id.is_some()
                && report.cohort_start_date.is_some()
                && report.cohort_start_date.as_ref() <= Some(&report.attendance_date)
                && report
                    .cohort_end_date
                    .as_ref()
                    .is_none_or(|end| &report.attendance_date <= end)
        }
        AttendanceCohortStatus::Upcoming => {
            report.cohort_id.is_none()
                && report
                    .cohort_start_date
                    .as_ref()
                    .is_some_and(|start| start > &report.attendance_date)
        }
        AttendanceCohortStatus::Ended => {
            report.cohort_id.is_none()
                && report
                    .cohort_end_date
                    .as_ref()
                    .is_some_and(|end| end < &report.attendance_date)
        }
        AttendanceCohortStatus::None => {
            report.cohort_id.is_none()
                && report.cohort_start_date.is_none()
                && report.cohort_end_date.is_none()
        }
        AttendanceCohortStatus::Unknown => report.cohort_id.is_none(),
    };
    if !status_valid
        || (report.cohort_status != AttendanceCohortStatus::Active
            && (report.morning_checked || report.evening_checked))
    {
        return Err("LMS_AGENT_REPORT_INVALID".into());
    }
    Ok(())
}

fn validate_subject(subject: &str) -> Result<(), String> {
    if is_bounded_trimmed_text(subject, 1, MAX_SUBJECT_BYTES)
        && !has_disallowed_control(subject, false)
    {
        Ok(())
    } else {
        Err("LMS_AGENT_REPORT_INVALID".into())
    }
}

pub(crate) fn parse_notification_page(value: &str) -> Result<NotificationPage, String> {
    let page: NotificationPage =
        serde_json::from_str(value).map_err(|_| "NOTIFICATION_PAYLOAD_INVALID".to_owned())?;
    validate_notification_page(&page)?;
    Ok(page)
}

pub(crate) fn validate_notification_page(page: &NotificationPage) -> Result<(), String> {
    if page.notifications.len() > MAX_NOTIFICATION_DELIVERIES {
        return Err("NOTIFICATION_PAYLOAD_INVALID".into());
    }
    let mut delivery_ids = HashSet::with_capacity(page.notifications.len());
    for delivery in &page.notifications {
        if !is_safe_route_segment(&delivery.delivery_id, MAX_DELIVERY_ID_BYTES)
            || !is_safe_route_segment(&delivery.event_id, MAX_EVENT_ID_BYTES)
            || !is_bounded_trimmed_chars(&delivery.title, 1, MAX_NOTIFICATION_TITLE_CHARS)
            || has_disallowed_control(&delivery.title, false)
            || !is_bounded_trimmed_chars(&delivery.body, 1, MAX_NOTIFICATION_BODY_CHARS)
            || has_disallowed_control(&delivery.body, true)
            || !is_safe_relative_path(&delivery.path)
            || delivery.created_at_epoch_ms < 0
            || !(1..=MAX_NOTIFICATION_ATTEMPT).contains(&delivery.attempt)
            || !delivery_ids.insert(delivery.delivery_id.as_str())
        {
            return Err("NOTIFICATION_PAYLOAD_INVALID".into());
        }
    }
    Ok(())
}

pub(crate) fn is_safe_route_segment(value: &str, max_bytes: usize) -> bool {
    (1..=max_bytes).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn is_safe_relative_path(value: &str) -> bool {
    value.starts_with('/')
        && !value.starts_with("//")
        && value.len() <= MAX_NOTIFICATION_PATH_BYTES
        && !value.contains('\\')
        && !has_disallowed_control(value, false)
}

fn is_bounded_trimmed_text(value: &str, minimum_bytes: usize, maximum_bytes: usize) -> bool {
    (minimum_bytes..=maximum_bytes).contains(&value.len()) && value.trim() == value
}

fn is_bounded_trimmed_chars(value: &str, minimum: usize, maximum: usize) -> bool {
    let count = value.chars().count();
    (minimum..=maximum).contains(&count) && value.trim() == value
}

fn has_disallowed_control(value: &str, allow_newline: bool) -> bool {
    value.chars().any(|character| {
        character.is_control() && !(allow_newline && matches!(character, '\n' | '\t'))
    })
}

fn is_date(value: &str) -> bool {
    if value.len() != 10 {
        return false;
    }
    let bytes = value.as_bytes();
    if bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes
            .iter()
            .enumerate()
            .any(|(index, byte)| !matches!(index, 4 | 7) && !byte.is_ascii_digit())
    {
        return false;
    }
    let Ok(year) = value[0..4].parse::<u32>() else {
        return false;
    };
    let Ok(month) = value[5..7].parse::<u32>() else {
        return false;
    };
    let Ok(day) = value[8..10].parse::<u32>() else {
        return false;
    };
    if year == 0 || !(1..=12).contains(&month) {
        return false;
    }
    let leap = year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400));
    let days = match month {
        2 if leap => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    };
    (1..=days).contains(&day)
}

fn is_iso_timestamp(value: &str) -> bool {
    if !(20..=40).contains(&value.len())
        || value.get(10..11) != Some("T")
        || !is_date(value.get(0..10).unwrap_or_default())
    {
        return false;
    }
    let Some(time) = value.get(11..) else {
        return false;
    };
    let valid_hour = time
        .get(0..2)
        .and_then(|part| part.parse::<u32>().ok())
        .is_some_and(|hour| hour <= 23);
    let valid_minute = time
        .get(3..5)
        .and_then(|part| part.parse::<u32>().ok())
        .is_some_and(|minute| minute <= 59);
    let valid_second = time
        .get(6..8)
        .and_then(|part| part.parse::<u32>().ok())
        .is_some_and(|second| second <= 59);
    if time.len() < 9
        || time.get(2..3) != Some(":")
        || time.get(5..6) != Some(":")
        || !valid_hour
        || !valid_minute
        || !valid_second
    {
        return false;
    }
    let suffix = &time[8..];
    if suffix == "Z" {
        return true;
    }
    if let Some(fraction) = suffix.strip_prefix('.') {
        if let Some(digits) = fraction.strip_suffix('Z') {
            return !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit());
        }
        if let Some(offset_index) = fraction.find(['+', '-']) {
            let (digits, offset) = fraction.split_at(offset_index);
            return !digits.is_empty()
                && digits.bytes().all(|byte| byte.is_ascii_digit())
                && is_timezone_offset(offset);
        }
        return false;
    }
    is_timezone_offset(suffix)
}

fn is_timezone_offset(value: &str) -> bool {
    value.len() == 6
        && matches!(value.as_bytes()[0], b'+' | b'-')
        && value.as_bytes()[3] == b':'
        && value[1..3].parse::<u32>().is_ok_and(|hour| hour <= 23)
        && value[4..6].parse::<u32>().is_ok_and(|minute| minute <= 59)
}

#[cfg(test)]
mod tests {
    use super::{
        parse_agent_report, parse_notification_page, AttendanceSnapshotUpload,
        CollectorDiagnosticReport, CollectorFailureReason, CollectorStage, LmsAgentReport,
    };

    #[test]
    fn accepts_one_strict_connected_agent_report() {
        let report = parse_agent_report(
            r#"{
              "state":"connected",
              "subject":"userId:42",
              "attendanceDate":"2026-07-31",
              "cohortId":"cohort-7",
              "cohortStatus":"active",
              "cohortStartDate":"2026-07-01",
              "cohortEndDate":"2026-08-01",
              "morningChecked":true,
              "eveningChecked":false,
              "collectedAt":"2026-07-31T01:02:03.000Z"
            }"#,
        )
        .expect("valid report");

        assert!(matches!(report, LmsAgentReport::Connected(_)));
    }

    #[test]
    fn accepts_a_session_only_report_when_attendance_fetch_is_transiently_unavailable() {
        let report = parse_agent_report(r#"{"state":"session-connected","subject":"student-42"}"#)
            .expect("valid session report");

        assert!(matches!(report, LmsAgentReport::SessionConnected(_)));
    }

    #[test]
    fn accepts_only_bounded_collector_diagnostics_without_sensitive_fields() {
        let report = parse_agent_report(
            r#"{"state":"collector-diagnostic","stage":"cohorts","reason":"invalid-payload"}"#,
        )
        .expect("valid diagnostic");
        assert!(matches!(
            report,
            LmsAgentReport::CollectorDiagnostic(CollectorDiagnosticReport {
                stage: CollectorStage::Cohorts,
                reason: CollectorFailureReason::InvalidPayload,
            })
        ));
        assert!(parse_agent_report(
            r#"{"state":"collector-diagnostic","stage":"cohorts","reason":"invalid-payload","body":"secret"}"#,
        )
        .is_err());
    }

    #[test]
    fn rejects_unknown_agent_fields_and_inconsistent_snapshots() {
        for payload in [
            r#"{"state":"login-required","cookies":"must-not-cross"}"#,
            r#"{"state":"session-connected","subject":"student-42","cookie":"secret"}"#,
            r#"{"state":"connected","subject":"userId:42","attendanceDate":"2026-07-31","cohortId":null,"cohortStatus":"active","cohortStartDate":"2026-07-01","cohortEndDate":"2026-08-01","morningChecked":true,"eveningChecked":false,"collectedAt":"2026-07-31T01:02:03.000Z"}"#,
            r#"{"state":"connected","subject":"userId:42","attendanceDate":"2026-02-30","cohortId":null,"cohortStatus":"none","cohortStartDate":null,"cohortEndDate":null,"morningChecked":false,"eveningChecked":false,"collectedAt":"2026-07-31T01:02:03.000Z"}"#,
            r#"{"state":"connected","subject":"userId:42","attendanceDate":"2026-07-31","cohortId":null,"cohortStatus":"none","cohortStartDate":null,"cohortEndDate":null,"morningChecked":false,"eveningChecked":false,"collectedAt":"2026-07-31Tab:02:03.000Z"}"#,
        ] {
            assert!(parse_agent_report(payload).is_err(), "{payload}");
        }
    }

    #[test]
    fn attendance_upload_serializes_only_the_server_contract() {
        let report = parse_agent_report(
            r#"{"state":"connected","subject":"id:student-1","attendanceDate":"2026-07-31","cohortId":null,"cohortStatus":"none","cohortStartDate":null,"cohortEndDate":null,"morningChecked":false,"eveningChecked":false,"collectedAt":"2026-07-31T01:02:03.000Z"}"#,
        )
        .expect("valid report");
        let LmsAgentReport::Connected(connected) = report else {
            panic!("connected report");
        };
        let upload = AttendanceSnapshotUpload::from(connected);
        let json = serde_json::to_value(upload).expect("serializable");

        assert_eq!(
            json,
            serde_json::json!({
                "attendanceDate":"2026-07-31",
                "cohortId":null,
                "cohortStatus":"none",
                "cohortStartDate":null,
                "cohortEndDate":null,
                "morningChecked":false,
                "eveningChecked":false,
                "collectedAt":"2026-07-31T01:02:03.000Z"
            })
        );
    }

    #[test]
    fn notification_page_is_bounded_and_rejects_unsafe_navigation() {
        let page = parse_notification_page(
            r#"{"notifications":[{
              "deliveryId":"delivery_1",
              "eventId":"event_1",
              "kind":"laundry-completed",
              "title":"세탁 완료",
              "body":"1번 세탁기의 세탁이 끝났습니다.",
              "path":"/laundry",
              "createdAtEpochMs":1785463200000,
              "attempt":1
            }]}"#,
        )
        .expect("valid page");
        assert_eq!(page.notifications.len(), 1);
        assert_eq!(
            page.notifications[0].kind,
            super::NotificationKind::LaundryCompleted
        );

        for payload in [
            r#"{"notifications":[{"deliveryId":"../ack","eventId":"event_1","kind":"laundry-completed","title":"x","body":"y","path":"/laundry","createdAtEpochMs":1785463200000,"attempt":1}]}"#,
            r#"{"notifications":[{"deliveryId":"delivery_1","eventId":"event_1","kind":"laundry-completed","title":"x","body":"y","path":"https://evil.example","createdAtEpochMs":1785463200000,"attempt":1}]}"#,
            r#"{"notifications":[{"deliveryId":"delivery_1","eventId":"event_1","kind":"future-private-kind","title":"x","body":"y","path":"/app","createdAtEpochMs":1785463200000,"attempt":1}]}"#,
            r#"{"notifications":[],"token":"secret"}"#,
        ] {
            assert!(parse_notification_page(payload).is_err(), "{payload}");
        }
    }

    #[test]
    fn notification_kind_allowlist_matches_the_server_envelope_contract() {
        let cases = [
            ("meal-published", super::NotificationKind::MealPublished),
            (
                "laundry-finishing",
                super::NotificationKind::LaundryFinishing,
            ),
            (
                "laundry-completed",
                super::NotificationKind::LaundryCompleted,
            ),
            (
                "laundry-available",
                super::NotificationKind::LaundryAvailable,
            ),
            (
                "laundry-attention",
                super::NotificationKind::LaundryAttention,
            ),
            (
                "attendance-action-required",
                super::NotificationKind::AttendanceActionRequired,
            ),
            ("login-required", super::NotificationKind::LoginRequired),
        ];
        for (kind, expected) in cases {
            let payload = format!(
                r#"{{"notifications":[{{"deliveryId":"delivery_1","eventId":"event_1","kind":"{kind}","title":"x","body":"y","path":"/app","createdAtEpochMs":1785463200000,"attempt":1}}]}}"#
            );
            let page = parse_notification_page(&payload).expect("known server kind");
            assert_eq!(page.notifications[0].kind, expected);
        }
    }
}
