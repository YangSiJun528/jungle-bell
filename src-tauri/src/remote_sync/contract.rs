use super::*;

pub(crate) fn normalize_api_origin(value: &str, allow_loopback_http: bool) -> Result<String, &'static str> {
    let trimmed = value.trim().trim_end_matches('/');
    let url = Url::parse(trimmed).map_err(|_| "API_ORIGIN_INVALID")?;
    let is_https = url.scheme() == "https";
    let is_loopback_http =
        allow_loopback_http && url.scheme() == "http" && matches!(url.host_str(), Some("127.0.0.1" | "localhost"));
    if (!is_https && !is_loopback_http)
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !matches!(url.path(), "" | "/")
    {
        return Err("API_ORIGIN_INVALID");
    }
    Ok(trimmed.to_owned())
}

pub(crate) fn is_safe_route_segment(value: &str) -> bool {
    (1..=128).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

pub(crate) fn is_safe_notification_text(value: &str, max_chars: usize, allow_newline: bool) -> bool {
    let count = value.chars().count();
    (1..=max_chars).contains(&count)
        && value.trim() == value
        && !value
            .chars()
            .any(|character| character.is_control() && !(allow_newline && matches!(character, '\n' | '\t')))
}

pub(crate) fn is_exact_lms_checker_context(label: &str, url: &Url) -> bool {
    label == CHECKER_WINDOW_LABEL
        && url.scheme() == "https"
        && url.host_str() == Some(LMS_HOST)
        && url.port_or_known_default() == Some(443)
        && url.username().is_empty()
        && url.password().is_none()
}

pub(crate) fn checker_context_is_allowed(label: &str, last_loaded_url: Option<&str>) -> bool {
    last_loaded_url
        .and_then(|value| Url::parse(value).ok())
        .is_some_and(|url| is_exact_lms_checker_context(label, &url))
}

pub(crate) fn ensure_dashboard_window(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == DASHBOARD_WINDOW_LABEL {
        Ok(())
    } else {
        Err("COMMAND_CONTEXT_DENIED".into())
    }
}

/// 대시보드 WebView의 실제 URL에서 서버가 허용하는 canonical origin을 만든다.
/// WHATWG에서 custom scheme의 `URL.origin`은 `null`이므로 scheme/host를 직접 검사한다.
pub(crate) fn dashboard_webview_origin(label: &str, url: &Url) -> Result<String, String> {
    if label != DASHBOARD_WINDOW_LABEL || !url.username().is_empty() || url.password().is_some() {
        return Err("COMMAND_CONTEXT_DENIED".into());
    }
    match (url.scheme(), url.host_str(), url.port()) {
        ("tauri", Some("localhost"), None) => Ok("tauri://localhost".into()),
        ("http", Some("tauri.localhost"), None) => Ok("http://tauri.localhost".into()),
        ("http", Some("127.0.0.1"), Some(5173)) => Ok("http://127.0.0.1:5173".into()),
        _ => Err("COMMAND_CONTEXT_DENIED".into()),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopHttpSessionRequest<'a> {
    pub(crate) origin: &'a str,
}

/// 단기 WebView bearer는 IPC 응답으로 한 번 전달할 뿐 Rust 상태나 로그에 저장하지 않는다.
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DesktopHttpSession {
    pub(crate) access_token: String,
    pub(crate) expires_at: String,
}

impl DesktopHttpSession {
    pub(crate) fn validate(&self) -> Result<(), ServiceError> {
        let token_valid = self.access_token.len() == 69
            && self.access_token.starts_with("jbui_")
            && self.access_token[5..]
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase());
        let now = Utc::now();
        let expiry_valid = DateTime::parse_from_rfc3339(&self.expires_at)
            .ok()
            .map(|value| value.with_timezone(&Utc))
            .is_some_and(|value| {
                value > now + chrono::Duration::seconds(30) && value <= now + chrono::Duration::minutes(10)
            });
        if token_valid && expiry_valid {
            Ok(())
        } else {
            Err(ServiceError::InvalidResponse)
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum LmsSessionState {
    Unknown,
    Connected,
    LoginRequired,
}

pub(crate) fn lms_session_state(state: &AppState) -> LmsSessionState {
    if state.needs_login {
        LmsSessionState::LoginRequired
    } else if state.data_loaded {
        LmsSessionState::Connected
    } else {
        LmsSessionState::Unknown
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopInstallationRequest {
    pub(crate) installation_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DesktopInstallationResponse {
    pub(crate) access_token: String,
    pub(crate) expires_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StoredCredentialRef<'a> {
    pub(crate) schema: &'static str,
    pub(crate) schema_version: u32,
    pub(crate) access_token: &'a str,
    pub(crate) expires_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct StoredCredentialValue {
    pub(crate) schema: String,
    pub(crate) schema_version: u32,
    pub(crate) access_token: String,
    pub(crate) expires_at: String,
}

pub(crate) struct BearerCredential {
    pub(crate) token: Zeroizing<String>,
    pub(crate) expires_at: DateTime<Utc>,
}

impl BearerCredential {
    pub(crate) fn from_wire(access_token: String, expires_at: &str) -> Result<Self, ServiceError> {
        let access_token = Zeroizing::new(access_token);
        if !is_app_bearer(&access_token) {
            return Err(ServiceError::InvalidResponse);
        }
        let now = Utc::now();
        let expires_at = DateTime::parse_from_rfc3339(expires_at)
            .ok()
            .map(|value| value.with_timezone(&Utc))
            .filter(|value| *value > now + chrono::Duration::seconds(30) && *value <= now + chrono::Duration::days(100))
            .ok_or(ServiceError::InvalidResponse)?;
        Ok(Self {
            token: access_token,
            expires_at,
        })
    }

    pub(crate) fn is_valid_at(&self, now: DateTime<Utc>) -> bool {
        self.expires_at > now + chrono::Duration::seconds(30)
    }

    pub(crate) fn should_rotate_at(&self, now: DateTime<Utc>) -> bool {
        self.expires_at <= now + chrono::Duration::days(CREDENTIAL_ROTATION_WINDOW_DAYS)
    }
}

pub(crate) fn is_app_bearer(value: &str) -> bool {
    value.len() == 68
        && value.starts_with("jbd_")
        && value[4..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectedServiceStatus {
    pub authenticated: bool,
    pub credential_persistent: bool,
    pub identity_reset_required: bool,
    pub lms_session_state: LmsSessionState,
    pub last_server_contact: Option<DateTime<Utc>>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum AttendanceCohortStatus {
    Active,
    Upcoming,
    Ended,
    None,
    Unknown,
}

impl From<CohortReportStatus> for AttendanceCohortStatus {
    fn from(value: CohortReportStatus) -> Self {
        match value {
            CohortReportStatus::Active => Self::Active,
            CohortReportStatus::Upcoming => Self::Upcoming,
            CohortReportStatus::Ended => Self::Ended,
            CohortReportStatus::NoCohort => Self::None,
            CohortReportStatus::Unknown => Self::Unknown,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AttendanceSnapshot {
    pub attendance_date: String,
    pub cohort_id: Option<String>,
    pub cohort_status: AttendanceCohortStatus,
    pub cohort_start_date: Option<String>,
    pub cohort_end_date: Option<String>,
    pub morning_checked: bool,
    pub evening_checked: bool,
    pub collected_at: String,
}

pub(crate) fn attendance_snapshot_from_checker(
    state: &AppState,
    report: &AttendanceReport,
    collected_at: DateTime<Utc>,
) -> Option<AttendanceSnapshot> {
    if report.api_error || report.needs_login {
        return None;
    }
    let cohort_status = AttendanceCohortStatus::from(report.cohort_status);
    let (cohort_id, cohort_start_date, cohort_end_date, morning_checked, evening_checked) = match cohort_status {
        AttendanceCohortStatus::Active => (
            state.effective_cohort_id.clone(),
            report.cohort_start_date.clone(),
            report.cohort_end_date.clone(),
            report.morning_done,
            report.evening_done,
        ),
        AttendanceCohortStatus::Upcoming | AttendanceCohortStatus::Ended => (
            None,
            report.cohort_start_date.clone(),
            report.cohort_end_date.clone(),
            false,
            false,
        ),
        AttendanceCohortStatus::None | AttendanceCohortStatus::Unknown => (None, None, None, false, false),
    };
    if cohort_status == AttendanceCohortStatus::Active && cohort_id.is_none() {
        return None;
    }
    let kst_now = collected_at.with_timezone(&crate::state::kst());
    let snapshot = AttendanceSnapshot {
        attendance_date: attendance_day::effective_attendance_date(kst_now),
        cohort_id,
        cohort_status,
        cohort_start_date,
        cohort_end_date,
        morning_checked,
        evening_checked,
        collected_at: collected_at.to_rfc3339_opts(SecondsFormat::Millis, true),
    };
    validate_attendance_snapshot(&snapshot).ok().map(|_| snapshot)
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RemoteAttendanceEnvelope {
    pub attendance: Option<AttendanceSnapshot>,
    pub freshness: RemoteAttendanceFreshness,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum RemoteAttendanceFreshness {
    Fresh,
    Stale,
    Missing,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum RemoteNotificationKind {
    MealPublished,
    LaundryFinishing,
    LaundryCompleted,
    LaundryAvailable,
    LaundryAttention,
    AttendanceActionRequired,
    LoginRequired,
    Test,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RemoteNotification {
    pub(crate) id: String,
    pub(crate) kind: RemoteNotificationKind,
    pub(crate) title: String,
    pub(crate) body: String,
    pub(crate) path: String,
    pub(crate) created_at_epoch_ms: i64,
    pub(crate) expires_at_epoch_ms: i64,
    pub(crate) attempt: u32,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RemoteNotificationEnvelope {
    pub(crate) notifications: Vec<RemoteNotification>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum NotificationAckOutcome {
    Displayed,
    Failed,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NotificationAck {
    pub(crate) outcome: NotificationAckOutcome,
    pub(crate) occurred_at_epoch_ms: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TestNotificationRequest {
    pub(crate) desktop_delivered: bool,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TestNotificationBroadcast {
    pub(crate) notification_id: String,
    pub(crate) queued: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Heartbeat<'a> {
    pub(crate) lms_session_state: LmsSessionState,
    pub(crate) app_version: &'a str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ServiceError {
    AuthenticationRequired,
    Unavailable,
    InvalidResponse,
    Rejected,
    Storage,
    IdentityResetRequired,
    StaleIdentity,
}

impl ServiceError {
    pub(crate) fn code(self) -> &'static str {
        match self {
            Self::AuthenticationRequired => "CONNECTED_SERVICE_AUTH_REQUIRED",
            Self::Unavailable => "CONNECTED_SERVICE_UNAVAILABLE",
            Self::InvalidResponse => "CONNECTED_SERVICE_RESPONSE_INVALID",
            Self::Rejected => "CONNECTED_SERVICE_REQUEST_REJECTED",
            Self::Storage => "CONNECTED_SERVICE_CREDENTIAL_STORAGE_FAILED",
            Self::IdentityResetRequired => "CONNECTED_SERVICE_IDENTITY_RESET_REQUIRED",
            Self::StaleIdentity => "CONNECTED_SERVICE_IDENTITY_CHANGED",
        }
    }
}
