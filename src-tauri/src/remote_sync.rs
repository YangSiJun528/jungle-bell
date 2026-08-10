//! 공개 웹 서비스와 기존 데스크톱 앱 사이의 보안 경계.
//!
//! 이 모듈은 LMS credential을 JS에 노출하지 않고 hidden checker WebView의
//! native cookie store에서 읽어 서버 검증에 한 번만 사용한다.

use std::{
    collections::BTreeSet,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};

use chrono::{DateTime, Datelike, SecondsFormat, Utc};
use reqwest::{redirect::Policy, Client, Response, StatusCode, Url};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use tauri::{webview::Cookie, Manager, WebviewWindow};
use tokio::sync::{Mutex, Notify, RwLock};
use zeroize::{Zeroize, Zeroizing};

use crate::{
    attendance::{AttendanceReport, CohortReportStatus},
    attendance_day,
    notification_service::{NotificationAction, NotificationRequest, NotificationService},
    secure_credential::{self, CredentialStore, VolatileCredentialStore},
    state::AppState,
};

const LMS_HOST: &str = "jungle-lms.krafton.com";
const LMS_ORIGIN: &str = "https://jungle-lms.krafton.com";
const CHECKER_WINDOW_LABEL: &str = "checker";
const DASHBOARD_WINDOW_LABEL: &str = "dashboard";
const ATTENDANCE_SNAPSHOT_PATH: &str = "/v1/attendance/snapshot";
const MAX_LMS_ACCESS_TOKEN_BYTES: usize = 8 * 1024;
const MAX_RESPONSE_BYTES: u64 = 512 * 1024;
const MAX_NOTIFICATION_DELIVERIES: usize = 20;
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(45);
const FALLBACK_SERVER_SILENCE_MINUTES: i64 = 5;
#[cfg(test)]
const FALLBACK_ATTENDANCE_WINDOW_SECONDS: i64 = 10 * 60;

#[derive(Clone, PartialEq)]
struct LmsCookieCandidate {
    name: String,
    value: String,
    domain: Option<String>,
    path: Option<String>,
    secure: Option<bool>,
    http_only: Option<bool>,
    expires: Option<f64>,
    same_site: Option<String>,
}

impl Drop for LmsCookieCandidate {
    fn drop(&mut self) {
        self.value.zeroize();
    }
}

#[derive(Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct LmsCookieUpload {
    name: String,
    value: String,
    domain: String,
    path: String,
    expires: f64,
    http_only: bool,
    secure: bool,
    same_site: String,
}

impl Drop for LmsCookieUpload {
    fn drop(&mut self) {
        self.value.zeroize();
    }
}

fn select_lms_access_cookie(cookies: &[LmsCookieCandidate]) -> Result<LmsCookieUpload, &'static str> {
    let mut selected = cookies
        .iter()
        .filter(|cookie| cookie.name == "access_token")
        .filter_map(normalize_lms_cookie);
    let Some(cookie) = selected.next() else {
        return Err("LMS_ACCESS_COOKIE_MISSING");
    };
    if selected.next().is_some() {
        return Err("LMS_ACCESS_COOKIE_AMBIGUOUS");
    }
    Ok(cookie)
}

fn normalize_lms_cookie(cookie: &LmsCookieCandidate) -> Option<LmsCookieUpload> {
    let domain = cookie
        .domain
        .as_deref()
        .unwrap_or(LMS_HOST)
        .trim_start_matches('.')
        .to_ascii_lowercase();
    let value_is_cookie_header_safe = !cookie.value.is_empty()
        && cookie.value.len() <= MAX_LMS_ACCESS_TOKEN_BYTES
        && cookie
            .value
            .bytes()
            .all(|byte| matches!(byte, 0x21..=0x3a | 0x3c..=0x5b | 0x5d..=0x7e));
    if domain != LMS_HOST
        || cookie.path.as_deref().unwrap_or("/") != "/"
        || cookie.secure != Some(true)
        || cookie.http_only != Some(true)
        || !value_is_cookie_header_safe
    {
        return None;
    }
    let same_site = cookie
        .same_site
        .as_deref()
        .filter(|value| matches!(*value, "Strict" | "Lax" | "None"))
        .unwrap_or("Lax")
        .to_owned();
    Some(LmsCookieUpload {
        name: "access_token".into(),
        value: cookie.value.clone(),
        domain,
        path: "/".into(),
        expires: cookie.expires.unwrap_or(-1.0),
        http_only: true,
        secure: true,
        same_site,
    })
}

fn normalize_api_origin(value: &str, allow_loopback_http: bool) -> Result<String, &'static str> {
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

fn is_safe_route_segment(value: &str) -> bool {
    (1..=128).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn is_manual_pairing_code(value: &str) -> bool {
    value.len() == 10
        && value.bytes().all(|byte| {
            byte.is_ascii_digit() || matches!(byte, b'A'..=b'H' | b'J' | b'K' | b'M' | b'N' | b'P'..=b'T' | b'V'..=b'Z')
        })
}

fn is_safe_notification_text(value: &str, max_chars: usize, allow_newline: bool) -> bool {
    let count = value.chars().count();
    (1..=max_chars).contains(&count)
        && value.trim() == value
        && !value
            .chars()
            .any(|character| character.is_control() && !(allow_newline && matches!(character, '\n' | '\t')))
}

#[cfg(test)]
fn fallback_due(
    now: DateTime<Utc>,
    last_server_contact: Option<DateTime<Utc>>,
    remaining_seconds: Option<i64>,
) -> bool {
    let Some(last_server_contact) = last_server_contact else {
        return false;
    };
    now.signed_duration_since(last_server_contact) >= chrono::Duration::minutes(FALLBACK_SERVER_SILENCE_MINUTES)
        && remaining_seconds.is_some_and(|remaining| (0..=FALLBACK_ATTENDANCE_WINDOW_SECONDS).contains(&remaining))
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

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum LmsSessionState {
    Unknown,
    Connected,
    LoginRequired,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VerifyLmsRequest {
    installation_id: String,
    cookies: Vec<LmsCookieUpload>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VerifyLmsResponse {
    access_token: String,
    expires_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredCredentialRef<'a> {
    access_token: &'a str,
    expires_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredCredentialValue {
    access_token: String,
    expires_at: String,
}

struct BearerCredential {
    token: Zeroizing<String>,
    expires_at: DateTime<Utc>,
}

impl BearerCredential {
    fn from_wire(access_token: String, expires_at: &str) -> Result<Self, ServiceError> {
        if !is_app_bearer(&access_token) {
            return Err(ServiceError::InvalidResponse);
        }
        let expires_at = parse_future_timestamp(expires_at).ok_or(ServiceError::InvalidResponse)?;
        Ok(Self {
            token: Zeroizing::new(access_token),
            expires_at,
        })
    }

    fn is_valid_at(&self, now: DateTime<Utc>) -> bool {
        self.expires_at > now + chrono::Duration::seconds(30)
    }
}

fn is_app_bearer(value: &str) -> bool {
    value.len() == 68
        && value.starts_with("jba_")
        && value[4..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn parse_future_timestamp(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|value| value.with_timezone(&Utc))
        .filter(|value| *value > Utc::now())
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectedServiceStatus {
    pub authenticated: bool,
    pub installation_id: String,
    pub credential_persistent: bool,
    pub last_server_contact: Option<DateTime<Utc>>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MobilePairing {
    #[serde(alias = "id")]
    pub pairing_id: String,
    pub qr_payload: String,
    pub manual_code: String,
    pub expires_at: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MobilePairingClaim {
    #[serde(alias = "id")]
    pub claim_id: String,
    pub device_label: String,
    pub confirmation_code: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MobilePairingStatus {
    pub status: String,
    pub claim: Option<MobilePairingClaim>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MobileDevice {
    pub device_id: String,
    pub device_label: String,
    pub installation_id: String,
    pub created_at: String,
    pub expires_at: String,
    pub last_seen_at: String,
    pub push_enabled: bool,
    pub status: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MobileDeviceEnvelope {
    devices: Vec<MobileDevice>,
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
        attendance_date: attendance_day::effective_attendance_date(&state.config, kst_now),
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
enum RemoteNotificationKind {
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
struct RemoteNotification {
    id: String,
    kind: RemoteNotificationKind,
    title: String,
    body: String,
    path: String,
    created_at_epoch_ms: i64,
    expires_at_epoch_ms: i64,
    attempt: u32,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RemoteNotificationEnvelope {
    notifications: Vec<RemoteNotification>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
enum NotificationAckOutcome {
    Displayed,
    Failed,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NotificationAck {
    outcome: NotificationAckOutcome,
    occurred_at_epoch_ms: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TestNotificationRequest {
    desktop_delivered: bool,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TestNotificationBroadcast {
    notification_id: String,
    queued: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Heartbeat<'a> {
    lms_session_state: LmsSessionState,
    app_version: &'a str,
    attendance_notifications: AttendanceNotificationPreferences,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct AttendanceNotificationPreferences {
    morning: bool,
    evening: bool,
    skip_sunday: bool,
    skip_attendance_date: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ServiceError {
    AuthenticationRequired,
    Unavailable,
    InvalidResponse,
    Rejected,
    Storage,
}

impl ServiceError {
    fn code(self) -> &'static str {
        match self {
            Self::AuthenticationRequired => "CONNECTED_SERVICE_AUTH_REQUIRED",
            Self::Unavailable => "CONNECTED_SERVICE_UNAVAILABLE",
            Self::InvalidResponse => "CONNECTED_SERVICE_RESPONSE_INVALID",
            Self::Rejected => "CONNECTED_SERVICE_REQUEST_REJECTED",
            Self::Storage => "CONNECTED_SERVICE_CREDENTIAL_STORAGE_FAILED",
        }
    }
}

#[derive(Clone)]
struct RemoteApi {
    origin: Url,
    client: Client,
}

impl RemoteApi {
    fn new(origin: &str) -> Result<Self, ServiceError> {
        let normalized =
            normalize_api_origin(origin, cfg!(debug_assertions)).map_err(|_| ServiceError::InvalidResponse)?;
        let origin = Url::parse(&normalized).map_err(|_| ServiceError::InvalidResponse)?;
        let client = Client::builder()
            .redirect(Policy::none())
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(15))
            .https_only(!cfg!(debug_assertions))
            .user_agent(concat!("JungleBell/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|_| ServiceError::Unavailable)?;
        Ok(Self { origin, client })
    }

    fn endpoint(&self, path: &str) -> Result<Url, ServiceError> {
        if !path.starts_with("/v1/") || path.contains(['?', '#', '\\']) {
            return Err(ServiceError::Rejected);
        }
        self.origin.join(path).map_err(|_| ServiceError::InvalidResponse)
    }

    async fn verify_lms(
        &self,
        installation_id: &str,
        cookie: LmsCookieUpload,
    ) -> Result<BearerCredential, ServiceError> {
        let response = self
            .client
            .post(self.endpoint("/v1/auth/lms/verify")?)
            .json(&VerifyLmsRequest {
                installation_id: installation_id.to_owned(),
                cookies: vec![cookie],
            })
            .send()
            .await
            .map_err(|_| ServiceError::Unavailable)?;
        ensure_status(&response, &[StatusCode::OK, StatusCode::CREATED])?;
        let body: VerifyLmsResponse = decode_json_limited(response).await?;
        BearerCredential::from_wire(body.access_token, &body.expires_at)
    }

    async fn create_pairing(&self, bearer: &str) -> Result<MobilePairing, ServiceError> {
        let response = self
            .client
            .post(self.endpoint("/v1/pairings")?)
            .bearer_auth(bearer)
            .json(&serde_json::json!({}))
            .send()
            .await
            .map_err(|_| ServiceError::Unavailable)?;
        ensure_authenticated_status(&response, &[StatusCode::OK, StatusCode::CREATED])?;
        let pairing: MobilePairing = decode_json_limited(response).await?;
        validate_pairing(&pairing, &self.origin)?;
        Ok(pairing)
    }

    async fn get_pairing_status(&self, bearer: &str, pairing_id: &str) -> Result<MobilePairingStatus, ServiceError> {
        let path = pairing_path(pairing_id, "")?;
        let response = self
            .client
            .get(self.endpoint(&path)?)
            .bearer_auth(bearer)
            .send()
            .await
            .map_err(|_| ServiceError::Unavailable)?;
        ensure_authenticated_status(&response, &[StatusCode::OK])?;
        let status: MobilePairingStatus = decode_json_limited(response).await?;
        validate_pairing_status(&status)?;
        Ok(status)
    }

    async fn approve_pairing(&self, bearer: &str, pairing_id: &str) -> Result<(), ServiceError> {
        let path = pairing_path(pairing_id, "/approve")?;
        let response = self
            .client
            .post(self.endpoint(&path)?)
            .bearer_auth(bearer)
            .json(&serde_json::json!({}))
            .send()
            .await
            .map_err(|_| ServiceError::Unavailable)?;
        ensure_authenticated_status(&response, &[StatusCode::OK, StatusCode::NO_CONTENT])
    }

    async fn list_devices(&self, bearer: &str) -> Result<Vec<MobileDevice>, ServiceError> {
        let response = self
            .client
            .get(self.endpoint("/v1/devices")?)
            .bearer_auth(bearer)
            .send()
            .await
            .map_err(|_| ServiceError::Unavailable)?;
        ensure_authenticated_status(&response, &[StatusCode::OK])?;
        let envelope: MobileDeviceEnvelope = decode_json_limited(response).await?;
        validate_devices(&envelope.devices)?;
        Ok(envelope.devices)
    }

    async fn revoke_device(&self, bearer: &str, device_id: &str) -> Result<(), ServiceError> {
        let path = device_path(device_id)?;
        let response = self
            .client
            .delete(self.endpoint(&path)?)
            .bearer_auth(bearer)
            .send()
            .await
            .map_err(|_| ServiceError::Unavailable)?;
        ensure_authenticated_status(&response, &[StatusCode::OK, StatusCode::NO_CONTENT])
    }

    async fn put_attendance(
        &self,
        bearer: &str,
        snapshot: &AttendanceSnapshot,
    ) -> Result<RemoteAttendanceEnvelope, ServiceError> {
        validate_attendance_snapshot(snapshot)?;
        let response = self
            .client
            .put(self.endpoint(ATTENDANCE_SNAPSHOT_PATH)?)
            .bearer_auth(bearer)
            .json(snapshot)
            .send()
            .await
            .map_err(|_| ServiceError::Unavailable)?;
        ensure_authenticated_status(&response, &[StatusCode::OK, StatusCode::CREATED])?;
        let envelope: RemoteAttendanceEnvelope = decode_json_limited(response).await?;
        validate_remote_attendance(&envelope)?;
        Ok(envelope)
    }

    async fn get_attendance(&self, bearer: &str) -> Result<RemoteAttendanceEnvelope, ServiceError> {
        let response = self
            .client
            .get(self.endpoint(ATTENDANCE_SNAPSHOT_PATH)?)
            .bearer_auth(bearer)
            .send()
            .await
            .map_err(|_| ServiceError::Unavailable)?;
        ensure_authenticated_status(&response, &[StatusCode::OK])?;
        let envelope: RemoteAttendanceEnvelope = decode_json_limited(response).await?;
        validate_remote_attendance(&envelope)?;
        Ok(envelope)
    }

    async fn heartbeat(
        &self,
        bearer: &str,
        state: LmsSessionState,
        preferences: AttendanceNotificationPreferences,
    ) -> Result<(), ServiceError> {
        let response = self
            .client
            .post(self.endpoint("/v1/desktop/heartbeat")?)
            .bearer_auth(bearer)
            .json(&Heartbeat {
                lms_session_state: state,
                app_version: env!("CARGO_PKG_VERSION"),
                attendance_notifications: preferences,
            })
            .send()
            .await
            .map_err(|_| ServiceError::Unavailable)?;
        ensure_authenticated_status(&response, &[StatusCode::OK, StatusCode::NO_CONTENT])
    }

    async fn notifications(&self, bearer: &str) -> Result<Vec<RemoteNotification>, ServiceError> {
        let response = self
            .client
            .get(self.endpoint("/v1/notifications/inbox")?)
            .bearer_auth(bearer)
            .send()
            .await
            .map_err(|_| ServiceError::Unavailable)?;
        ensure_authenticated_status(&response, &[StatusCode::OK])?;
        let mut envelope: RemoteNotificationEnvelope = decode_json_limited(response).await?;
        validate_notifications(&envelope.notifications)?;
        discard_expired_notifications(&mut envelope.notifications, Utc::now().timestamp_millis());
        Ok(envelope.notifications)
    }

    async fn acknowledge_notification(
        &self,
        bearer: &str,
        notification_id: &str,
        outcome: NotificationAckOutcome,
    ) -> Result<(), ServiceError> {
        if !is_safe_route_segment(notification_id) {
            return Err(ServiceError::Rejected);
        }
        let path = format!("/v1/notifications/{notification_id}/ack");
        let response = self
            .client
            .post(self.endpoint(&path)?)
            .bearer_auth(bearer)
            .json(&NotificationAck {
                outcome,
                occurred_at_epoch_ms: Utc::now().timestamp_millis(),
            })
            .send()
            .await
            .map_err(|_| ServiceError::Unavailable)?;
        ensure_authenticated_status(&response, &[StatusCode::OK, StatusCode::NO_CONTENT])
    }

    async fn send_test_notification(
        &self,
        bearer: &str,
        desktop_delivered: bool,
    ) -> Result<TestNotificationBroadcast, ServiceError> {
        let response = self
            .client
            .post(self.endpoint("/v1/notifications/test")?)
            .bearer_auth(bearer)
            .json(&TestNotificationRequest { desktop_delivered })
            .send()
            .await
            .map_err(|_| ServiceError::Unavailable)?;
        ensure_authenticated_status(&response, &[StatusCode::OK, StatusCode::ACCEPTED])?;
        let broadcast: TestNotificationBroadcast = decode_json_limited(response).await?;
        if !is_safe_route_segment(&broadcast.notification_id) || broadcast.queued > 100 {
            return Err(ServiceError::InvalidResponse);
        }
        Ok(broadcast)
    }
}

fn ensure_status(response: &Response, expected: &[StatusCode]) -> Result<(), ServiceError> {
    if expected.contains(&response.status()) {
        Ok(())
    } else if matches!(response.status(), StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN) {
        Err(ServiceError::AuthenticationRequired)
    } else if response.status().is_server_error() {
        Err(ServiceError::Unavailable)
    } else {
        Err(ServiceError::Rejected)
    }
}

fn ensure_authenticated_status(response: &Response, expected: &[StatusCode]) -> Result<(), ServiceError> {
    ensure_status(response, expected)
}

async fn decode_json_limited<T: DeserializeOwned>(response: Response) -> Result<T, ServiceError> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES)
    {
        return Err(ServiceError::InvalidResponse);
    }
    let bytes = response.bytes().await.map_err(|_| ServiceError::Unavailable)?;
    if bytes.len() as u64 > MAX_RESPONSE_BYTES {
        return Err(ServiceError::InvalidResponse);
    }
    serde_json::from_slice(&bytes).map_err(|_| ServiceError::InvalidResponse)
}

fn pairing_path(pairing_id: &str, suffix: &str) -> Result<String, ServiceError> {
    if !is_safe_route_segment(pairing_id) || !matches!(suffix, "" | "/approve") {
        return Err(ServiceError::Rejected);
    }
    Ok(format!("/v1/pairings/{pairing_id}{suffix}"))
}

fn device_path(device_id: &str) -> Result<String, ServiceError> {
    if !is_safe_route_segment(device_id) {
        return Err(ServiceError::Rejected);
    }
    Ok(format!("/v1/devices/{device_id}"))
}

fn validate_pairing(pairing: &MobilePairing, allowed_origin: &Url) -> Result<(), ServiceError> {
    if !is_safe_route_segment(&pairing.pairing_id)
        || !is_manual_pairing_code(&pairing.manual_code)
        || parse_future_timestamp(&pairing.expires_at).is_none()
        || !is_safe_pairing_url(&pairing.qr_payload, &pairing.pairing_id, allowed_origin)
    {
        return Err(ServiceError::InvalidResponse);
    }
    Ok(())
}

fn is_safe_pairing_url(value: &str, pairing_id: &str, allowed_origin: &Url) -> bool {
    if value.len() > 2_048 {
        return false;
    }
    let Ok(url) = Url::parse(value) else {
        return false;
    };
    if url.origin() != allowed_origin.origin()
        || url.path() != "/dashboard.html"
        || url.query().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return false;
    }
    let Some(fragment) = url.fragment() else {
        return false;
    };
    let mut pairing = None;
    let mut challenge = None;
    let mut count = 0;
    for part in fragment.split('&') {
        count += 1;
        let Some((key, value)) = part.split_once('=') else {
            return false;
        };
        match key {
            "pairing" if pairing.is_none() => pairing = Some(value),
            "challenge" if challenge.is_none() => challenge = Some(value),
            _ => return false,
        }
    }
    count == 2
        && pairing == Some(pairing_id)
        && challenge.is_some_and(|value| {
            value.len() == 69
                && value.starts_with("jbpc_")
                && value[5..]
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        })
}

fn validate_pairing_status(status: &MobilePairingStatus) -> Result<(), ServiceError> {
    if !matches!(
        status.status.as_str(),
        "pending" | "claimed" | "approved" | "completed" | "expired"
    ) {
        return Err(ServiceError::InvalidResponse);
    }
    if status.status == "claimed" {
        let Some(claim) = &status.claim else {
            return Err(ServiceError::InvalidResponse);
        };
        if !is_safe_route_segment(&claim.claim_id)
            || !is_safe_notification_text(&claim.device_label, 80, false)
            || claim.confirmation_code.len() != 4
            || !claim.confirmation_code.bytes().all(|byte| byte.is_ascii_alphanumeric())
        {
            return Err(ServiceError::InvalidResponse);
        }
    } else if status.claim.is_some() {
        return Err(ServiceError::InvalidResponse);
    }
    Ok(())
}

fn validate_devices(devices: &[MobileDevice]) -> Result<(), ServiceError> {
    if devices.len() > 100 {
        return Err(ServiceError::InvalidResponse);
    }
    let mut ids = BTreeSet::new();
    for device in devices {
        let timestamps_valid = [&device.created_at, &device.expires_at, &device.last_seen_at]
            .into_iter()
            .all(|value| DateTime::parse_from_rfc3339(value).is_ok());
        if !is_safe_route_segment(&device.device_id)
            || !ids.insert(device.device_id.as_str())
            || !is_safe_notification_text(&device.device_label, 80, false)
            || !is_safe_device_installation_id(&device.installation_id)
            || !timestamps_valid
            || !matches!(device.status.as_str(), "active" | "revoked" | "expired")
        {
            return Err(ServiceError::InvalidResponse);
        }
    }
    Ok(())
}

fn is_safe_device_installation_id(value: &str) -> bool {
    (8..=128).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
}

fn validate_attendance_snapshot(snapshot: &AttendanceSnapshot) -> Result<(), ServiceError> {
    let attendance_date = chrono::NaiveDate::parse_from_str(&snapshot.attendance_date, "%Y-%m-%d")
        .map_err(|_| ServiceError::InvalidResponse)?;
    let cohort_start = snapshot
        .cohort_start_date
        .as_deref()
        .map(|value| chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d"))
        .transpose()
        .map_err(|_| ServiceError::InvalidResponse)?;
    let cohort_end = snapshot
        .cohort_end_date
        .as_deref()
        .map(|value| chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d"))
        .transpose()
        .map_err(|_| ServiceError::InvalidResponse)?;
    if cohort_start.zip(cohort_end).is_some_and(|(start, end)| start > end)
        || snapshot
            .cohort_id
            .as_deref()
            .is_some_and(|id| id.is_empty() || id.len() > 128 || id.trim() != id || id.chars().any(char::is_control))
        || DateTime::parse_from_rfc3339(&snapshot.collected_at).is_err()
    {
        return Err(ServiceError::InvalidResponse);
    }

    let coherent = match snapshot.cohort_status {
        AttendanceCohortStatus::Active => snapshot.cohort_id.is_some(),
        AttendanceCohortStatus::Upcoming | AttendanceCohortStatus::Ended => {
            snapshot.cohort_id.is_none() && !snapshot.morning_checked && !snapshot.evening_checked
        }
        AttendanceCohortStatus::None => {
            snapshot.cohort_id.is_none()
                && cohort_start.is_none()
                && cohort_end.is_none()
                && !snapshot.morning_checked
                && !snapshot.evening_checked
        }
        AttendanceCohortStatus::Unknown => snapshot.cohort_id.is_none(),
    };
    if !coherent || attendance_date.year() < 2020 {
        return Err(ServiceError::InvalidResponse);
    }
    Ok(())
}

fn validate_remote_attendance(envelope: &RemoteAttendanceEnvelope) -> Result<(), ServiceError> {
    match (&envelope.attendance, envelope.freshness) {
        (Some(snapshot), RemoteAttendanceFreshness::Fresh | RemoteAttendanceFreshness::Stale) => {
            validate_attendance_snapshot(snapshot)?;
        }
        (None, RemoteAttendanceFreshness::Missing) => {}
        _ => return Err(ServiceError::InvalidResponse),
    }
    Ok(())
}

fn validate_notifications(notifications: &[RemoteNotification]) -> Result<(), ServiceError> {
    if notifications.len() > MAX_NOTIFICATION_DELIVERIES {
        return Err(ServiceError::InvalidResponse);
    }
    let mut ids = BTreeSet::new();
    for notification in notifications {
        if !is_safe_route_segment(&notification.id)
            || !ids.insert(notification.id.as_str())
            || !is_safe_notification_text(&notification.title, 80, false)
            || !is_safe_notification_text(&notification.body, 500, true)
            || !is_safe_relative_path(&notification.path)
            || notification.created_at_epoch_ms < 0
            || notification.expires_at_epoch_ms < notification.created_at_epoch_ms
            || !(1..=100).contains(&notification.attempt)
        {
            return Err(ServiceError::InvalidResponse);
        }
    }
    Ok(())
}

fn discard_expired_notifications(notifications: &mut Vec<RemoteNotification>, now_epoch_ms: i64) {
    notifications.retain(|notification| notification.expires_at_epoch_ms > now_epoch_ms);
}

fn is_safe_relative_path(value: &str) -> bool {
    value.starts_with('/')
        && !value.starts_with("//")
        && value.len() <= 512
        && !value.contains(['\\', '\0', '\n', '\r'])
}

#[derive(Debug, Default)]
struct SyncRuntime {
    credential_persistent: bool,
    last_server_contact: Option<DateTime<Utc>>,
    last_notification_contact: Option<DateTime<Utc>>,
    last_error: Option<String>,
}

pub(crate) struct RemoteSyncService {
    api: RemoteApi,
    installation_id: String,
    credential_store: Arc<dyn CredentialStore>,
    credential: RwLock<Option<BearerCredential>>,
    verification: Mutex<()>,
    runtime: Mutex<SyncRuntime>,
    snapshot_revision: AtomicU64,
    snapshot_uploaded: Notify,
}

impl RemoteSyncService {
    pub(crate) fn configured(app: &tauri::AppHandle) -> Result<Self, String> {
        let app_data_dir = app
            .path()
            .app_data_dir()
            .map_err(|_| "CONNECTED_SERVICE_STORAGE_UNAVAILABLE".to_owned())?;
        let installation_id =
            secure_credential::load_or_create_installation_id(&app_data_dir).map_err(str::to_owned)?;
        let credential_store: Arc<dyn CredentialStore> = Arc::new(VolatileCredentialStore::new());
        log::info!("[connected-service] server credential uses memory-only storage");
        let api = RemoteApi::new(&crate::data_api::base_url()).map_err(|error| error.code().to_owned())?;
        Self::with_store(api, installation_id, credential_store).map_err(|error| error.code().to_owned())
    }

    fn with_store(
        api: RemoteApi,
        installation_id: String,
        credential_store: Arc<dyn CredentialStore>,
    ) -> Result<Self, ServiceError> {
        secure_credential::parse_installation_id(&installation_id).map_err(|_| ServiceError::Storage)?;
        let loaded = if credential_store.is_persistent() {
            credential_store.load().unwrap_or_else(|error| {
                log::warn!("[connected-service] credential restore unavailable: {error}");
                None
            })
        } else {
            None
        };
        let mut credential_persistent = false;
        let credential = loaded.and_then(|stored| match decode_stored_credential(&stored) {
            Ok(credential) if credential.is_valid_at(Utc::now()) => {
                credential_persistent = true;
                Some(credential)
            }
            _ => {
                let _ = credential_store.clear();
                None
            }
        });
        // last_notification_contact는 실제 inbox poll 성공 전까지 None이다.
        // 저장된 bearer로 오프라인 시작하면 중요한 로컬 fallback이 즉시 활성화된다.
        let runtime = SyncRuntime {
            credential_persistent,
            ..SyncRuntime::default()
        };
        Ok(Self {
            api,
            installation_id,
            credential_store,
            credential: RwLock::new(credential),
            verification: Mutex::new(()),
            runtime: Mutex::new(runtime),
            snapshot_revision: AtomicU64::new(0),
            snapshot_uploaded: Notify::new(),
        })
    }

    pub(crate) async fn status(&self) -> ConnectedServiceStatus {
        let authenticated = self.current_bearer().await.is_some();
        let runtime = self.runtime.lock().await;
        ConnectedServiceStatus {
            authenticated,
            installation_id: self.installation_id.clone(),
            credential_persistent: runtime.credential_persistent,
            last_server_contact: runtime.last_server_contact,
            last_error: runtime.last_error.clone(),
        }
    }

    fn verification_needed(&self) -> bool {
        self.credential
            .try_read()
            .map(|credential| {
                credential
                    .as_ref()
                    .is_none_or(|credential| !credential.is_valid_at(Utc::now()))
            })
            .unwrap_or(false)
    }

    async fn current_bearer(&self) -> Option<Zeroizing<String>> {
        let credential = self.credential.read().await;
        credential
            .as_ref()
            .filter(|credential| credential.is_valid_at(Utc::now()))
            .map(|credential| Zeroizing::new(credential.token.to_string()))
    }

    async fn require_bearer(&self) -> Result<Zeroizing<String>, ServiceError> {
        self.current_bearer().await.ok_or(ServiceError::AuthenticationRequired)
    }

    async fn record_success(&self) {
        let mut runtime = self.runtime.lock().await;
        runtime.last_server_contact = Some(Utc::now());
        runtime.last_error = None;
    }

    async fn record_notification_success(&self) {
        let now = Utc::now();
        let mut runtime = self.runtime.lock().await;
        runtime.last_server_contact = Some(now);
        runtime.last_notification_contact = Some(now);
        runtime.last_error = None;
    }

    async fn record_error(&self, error: ServiceError) {
        if error == ServiceError::AuthenticationRequired {
            self.invalidate_credential().await;
        }
        self.runtime.lock().await.last_error = Some(error.code().into());
    }

    async fn invalidate_credential(&self) {
        *self.credential.write().await = None;
        let cleared = self.credential_store.clear().is_ok();
        let mut runtime = self.runtime.lock().await;
        runtime.credential_persistent = false;
        if self.credential_store.is_persistent() && !cleared {
            runtime.last_error = Some(ServiceError::Storage.code().into());
        }
    }

    async fn verify_lms_cookie(&self, cookie: LmsCookieUpload) -> Result<(), String> {
        if self.current_bearer().await.is_some() {
            return Ok(());
        }
        let _verification = self.verification.lock().await;
        if self.current_bearer().await.is_some() {
            return Ok(());
        }

        let result = self.api.verify_lms(&self.installation_id, cookie).await;
        match result {
            Ok(credential) => {
                let persistence_enabled = self.credential_store.is_persistent();
                let persisted =
                    persistence_enabled && persist_credential(self.credential_store.as_ref(), &credential).is_ok();
                *self.credential.write().await = Some(credential);
                let mut runtime = self.runtime.lock().await;
                runtime.credential_persistent = persisted;
                runtime.last_server_contact = Some(Utc::now());
                runtime.last_error = if persistence_enabled && !persisted {
                    Some(ServiceError::Storage.code().into())
                } else {
                    None
                };
                log::info!("[connected-service] LMS session verified; desktop credential ready");
                Ok(())
            }
            Err(error) => {
                self.record_error(error).await;
                Err(error.code().into())
            }
        }
    }

    pub(crate) async fn create_pairing(&self) -> Result<MobilePairing, String> {
        let bearer = self.require_bearer().await.map_err(|error| error.code().to_owned())?;
        match self.api.create_pairing(&bearer).await {
            Ok(pairing) => {
                self.record_success().await;
                Ok(pairing)
            }
            Err(error) => {
                self.record_error(error).await;
                Err(error.code().into())
            }
        }
    }

    pub(crate) async fn pairing_status(&self, pairing_id: &str) -> Result<MobilePairingStatus, String> {
        if !is_safe_route_segment(pairing_id) {
            return Err("PAIRING_ID_INVALID".into());
        }
        let bearer = self.require_bearer().await.map_err(|error| error.code().to_owned())?;
        match self.api.get_pairing_status(&bearer, pairing_id).await {
            Ok(status) => {
                self.record_success().await;
                Ok(status)
            }
            Err(error) => {
                self.record_error(error).await;
                Err(error.code().into())
            }
        }
    }

    pub(crate) async fn approve_pairing(&self, pairing_id: &str, claim_id: &str) -> Result<(), String> {
        if !is_safe_route_segment(pairing_id) || !is_safe_route_segment(claim_id) {
            return Err("PAIRING_CLAIM_INVALID".into());
        }
        let bearer = self.require_bearer().await.map_err(|error| error.code().to_owned())?;
        let status = self
            .api
            .get_pairing_status(&bearer, pairing_id)
            .await
            .map_err(|error| error.code().to_owned())?;
        let claim_matches =
            status.status == "claimed" && status.claim.as_ref().is_some_and(|claim| claim.claim_id == claim_id);
        if !claim_matches {
            return Err("PAIRING_CLAIM_MISMATCH".into());
        }
        match self.api.approve_pairing(&bearer, pairing_id).await {
            Ok(()) => {
                self.record_success().await;
                Ok(())
            }
            Err(error) => {
                self.record_error(error).await;
                Err(error.code().into())
            }
        }
    }

    pub(crate) async fn devices(&self) -> Result<Vec<MobileDevice>, String> {
        let bearer = self.require_bearer().await.map_err(|error| error.code().to_owned())?;
        match self.api.list_devices(&bearer).await {
            Ok(devices) => {
                self.record_success().await;
                Ok(devices)
            }
            Err(error) => {
                self.record_error(error).await;
                Err(error.code().into())
            }
        }
    }

    pub(crate) async fn revoke_device(&self, device_id: &str) -> Result<(), String> {
        if !is_safe_route_segment(device_id) {
            return Err("DEVICE_ID_INVALID".into());
        }
        let bearer = self.require_bearer().await.map_err(|error| error.code().to_owned())?;
        match self.api.revoke_device(&bearer, device_id).await {
            Ok(()) => {
                self.record_success().await;
                Ok(())
            }
            Err(error) => {
                self.record_error(error).await;
                Err(error.code().into())
            }
        }
    }

    pub(crate) async fn upload_attendance(&self, snapshot: &AttendanceSnapshot) -> Result<(), String> {
        let Some(bearer) = self.current_bearer().await else {
            return Ok(());
        };
        match self.api.put_attendance(&bearer, snapshot).await {
            Ok(_) => {
                self.record_success().await;
                self.snapshot_revision.fetch_add(1, Ordering::Release);
                self.snapshot_uploaded.notify_waiters();
                Ok(())
            }
            Err(error) => {
                self.record_error(error).await;
                Err(error.code().into())
            }
        }
    }

    pub(crate) async fn attendance(&self) -> Result<RemoteAttendanceEnvelope, String> {
        let bearer = self.require_bearer().await.map_err(|error| error.code().to_owned())?;
        match self.api.get_attendance(&bearer).await {
            Ok(attendance) => {
                self.record_success().await;
                Ok(attendance)
            }
            Err(error) => {
                self.record_error(error).await;
                Err(error.code().into())
            }
        }
    }

    pub(crate) async fn broadcast_test_notification(&self, desktop_delivered: bool) -> Result<usize, String> {
        let bearer = self.require_bearer().await.map_err(|error| error.code().to_owned())?;
        match self.api.send_test_notification(&bearer, desktop_delivered).await {
            Ok(broadcast) => {
                self.record_success().await;
                Ok(broadcast.queued)
            }
            Err(error) => {
                self.record_error(error).await;
                Err(error.code().into())
            }
        }
    }

    async fn wait_for_snapshot_after(&self, baseline: u64) {
        loop {
            let notified = self.snapshot_uploaded.notified();
            if self.snapshot_revision.load(Ordering::Acquire) > baseline {
                return;
            }
            notified.await;
        }
    }

    async fn send_heartbeat(
        &self,
        state: LmsSessionState,
        preferences: AttendanceNotificationPreferences,
    ) -> Result<(), ServiceError> {
        let bearer = self.require_bearer().await?;
        let result = self.api.heartbeat(&bearer, state, preferences).await;
        match result {
            Ok(()) => {
                self.record_success().await;
                Ok(())
            }
            Err(error) => {
                self.record_error(error).await;
                Err(error)
            }
        }
    }

    async fn poll_notifications(&self) -> Result<Vec<RemoteNotification>, ServiceError> {
        let bearer = self.require_bearer().await?;
        let result = self.api.notifications(&bearer).await;
        match result {
            Ok(notifications) => {
                self.record_notification_success().await;
                Ok(notifications)
            }
            Err(error) => {
                self.record_error(error).await;
                Err(error)
            }
        }
    }

    async fn acknowledge(&self, notification_id: &str, outcome: NotificationAckOutcome) -> Result<(), ServiceError> {
        let bearer = self.require_bearer().await?;
        let result = self
            .api
            .acknowledge_notification(&bearer, notification_id, outcome)
            .await;
        match result {
            Ok(()) => {
                self.record_success().await;
                Ok(())
            }
            Err(error) => {
                self.record_error(error).await;
                Err(error)
            }
        }
    }
}

fn decode_stored_credential(value: &str) -> Result<BearerCredential, ServiceError> {
    let stored: StoredCredentialValue = serde_json::from_str(value).map_err(|_| ServiceError::Storage)?;
    BearerCredential::from_wire(stored.access_token, &stored.expires_at).map_err(|_| ServiceError::Storage)
}

fn persist_credential(store: &dyn CredentialStore, credential: &BearerCredential) -> Result<(), ServiceError> {
    let value = StoredCredentialRef {
        access_token: &credential.token,
        expires_at: credential.expires_at.to_rfc3339_opts(SecondsFormat::Millis, true),
    };
    let serialized = Zeroizing::new(serde_json::to_string(&value).map_err(|_| ServiceError::Storage)?);
    store.store(&serialized).map_err(|_| ServiceError::Storage)
}

fn cookie_candidate(cookie: &Cookie<'static>) -> LmsCookieCandidate {
    LmsCookieCandidate {
        name: cookie.name().to_owned(),
        value: cookie.value().to_owned(),
        domain: cookie.domain().map(str::to_owned),
        path: cookie.path().map(str::to_owned),
        secure: cookie.secure(),
        http_only: cookie.http_only(),
        expires: cookie.expires_datetime().map(|value| value.unix_timestamp() as f64),
        same_site: cookie.same_site().map(|value| format!("{value:?}")),
    }
}

async fn lms_cookie_from_checker(window: WebviewWindow, last_loaded_url: &str) -> Result<LmsCookieUpload, String> {
    let page_url = Url::parse(last_loaded_url).map_err(|_| "COMMAND_CONTEXT_DENIED".to_owned())?;
    if !is_exact_lms_checker_context(window.label(), &page_url) {
        return Err("COMMAND_CONTEXT_DENIED".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let target = Url::parse(LMS_ORIGIN).map_err(|_| "LMS_COOKIE_READ_FAILED".to_owned())?;
        let cookies = window
            .cookies_for_url(target)
            .map_err(|_| "LMS_COOKIE_READ_FAILED".to_owned())?;
        let candidates = cookies.iter().map(cookie_candidate).collect::<Vec<_>>();
        select_lms_access_cookie(&candidates).map_err(str::to_owned)
    })
    .await
    .map_err(|_| "LMS_COOKIE_READ_FAILED".to_owned())?
}

pub(crate) fn sync_checker_report(
    window: WebviewWindow,
    last_loaded_url: String,
    service: Arc<RemoteSyncService>,
    snapshot: Option<AttendanceSnapshot>,
) {
    tauri::async_runtime::spawn(async move {
        if service.verification_needed() {
            let cookie = match lms_cookie_from_checker(window, &last_loaded_url).await {
                Ok(cookie) => cookie,
                Err(error) => {
                    log::warn!("[connected-service] LMS native cookie boundary rejected: {error}");
                    return;
                }
            };
            if let Err(error) = service.verify_lms_cookie(cookie).await {
                log::warn!("[connected-service] LMS verification failed: {error}");
                return;
            }
        }
        if let Some(snapshot) = snapshot {
            if let Err(error) = service.upload_attendance(&snapshot).await {
                log::debug!("[connected-service] attendance snapshot deferred: {error}");
            }
        }
    });
}

fn notification_action(kind: RemoteNotificationKind) -> Option<NotificationAction> {
    match kind {
        RemoteNotificationKind::MealPublished => Some(NotificationAction::Meals),
        RemoteNotificationKind::LaundryFinishing
        | RemoteNotificationKind::LaundryCompleted
        | RemoteNotificationKind::LaundryAvailable
        | RemoteNotificationKind::LaundryAttention => Some(NotificationAction::Laundry),
        RemoteNotificationKind::AttendanceActionRequired | RemoteNotificationKind::LoginRequired => {
            Some(NotificationAction::Attendance)
        }
        RemoteNotificationKind::Test => None,
    }
}

async fn deliver_server_notifications(
    app: &tauri::AppHandle,
    service: &RemoteSyncService,
    notifications: &NotificationService,
    deliveries: Vec<RemoteNotification>,
) {
    for delivery in deliveries {
        let key = format!("server:{}", delivery.id);
        let report = notifications.deliver(
            app,
            NotificationRequest {
                key: &key,
                title: &delivery.title,
                body: &delivery.body,
                action: notification_action(delivery.kind),
                repeat_after_ms: None,
            },
        );
        let outcome = if report.any_delivered() {
            NotificationAckOutcome::Displayed
        } else {
            NotificationAckOutcome::Failed
        };
        if let Err(error) = service.acknowledge(&delivery.id, outcome).await {
            log::warn!(
                "[connected-service] notification ack deferred: id={} error={}",
                delivery.id,
                error.code(),
            );
        }
    }
}

async fn update_notification_authority(state: &Arc<Mutex<AppState>>, service: &RemoteSyncService, now: DateTime<Utc>) {
    let authenticated = service.current_bearer().await.is_some();
    let last_contact = service.runtime.lock().await.last_notification_contact;
    let next = notification_authority(authenticated, last_contact, now);
    let mut state = state.lock().await;
    if state.attendance_notification_authority != next {
        log::info!(
            "[connected-service] attendance notification authority: {:?} -> {:?}",
            state.attendance_notification_authority,
            next,
        );
        state.attendance_notification_authority = next;
        state.notify_scheduler();
    }
}

fn notification_authority(
    authenticated: bool,
    last_contact: Option<DateTime<Utc>>,
    now: DateTime<Utc>,
) -> crate::state::AttendanceNotificationAuthority {
    if !authenticated {
        crate::state::AttendanceNotificationAuthority::LegacyLocal
    } else if last_contact.is_some_and(|last| {
        now.signed_duration_since(last) < chrono::Duration::minutes(FALLBACK_SERVER_SILENCE_MINUTES)
    }) {
        crate::state::AttendanceNotificationAuthority::Server
    } else {
        crate::state::AttendanceNotificationAuthority::LocalFallback
    }
}

pub(crate) fn start_background_loop(
    app: tauri::AppHandle,
    service: Arc<RemoteSyncService>,
    state: Arc<Mutex<AppState>>,
    notifications: Arc<NotificationService>,
) {
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(HEARTBEAT_INTERVAL);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;

            let (session_state, preferences) = {
                let state = state.lock().await;
                let session_state = if state.needs_login {
                    LmsSessionState::LoginRequired
                } else if state.data_loaded {
                    LmsSessionState::Connected
                } else {
                    LmsSessionState::Unknown
                };
                let preferences = AttendanceNotificationPreferences {
                    morning: state.config.start_notification_enabled,
                    evening: state.config.end_notification_enabled,
                    skip_sunday: state.config.skip_sunday,
                    skip_attendance_date: state.config.skip_attendance.clone(),
                };
                (session_state, preferences)
            };
            let authenticated = service.current_bearer().await.is_some();

            if authenticated {
                if let Err(error) = service.send_heartbeat(session_state, preferences).await {
                    log::debug!("[connected-service] heartbeat deferred: {}", error.code());
                }
                match service.poll_notifications().await {
                    Ok(deliveries) => {
                        deliver_server_notifications(&app, &service, &notifications, deliveries).await;
                    }
                    Err(error) => {
                        log::debug!("[connected-service] notification poll deferred: {}", error.code());
                    }
                }
            }

            update_notification_authority(&state, &service, Utc::now()).await;
        }
    });
}

pub(crate) async fn get_connected_service_status(
    window: WebviewWindow,
    service: tauri::State<'_, Arc<RemoteSyncService>>,
) -> Result<ConnectedServiceStatus, String> {
    ensure_dashboard_window(&window)?;
    Ok(service.status().await)
}

pub(crate) fn open_lms_login(window: WebviewWindow, app: tauri::AppHandle) -> Result<(), String> {
    ensure_dashboard_window(&window)?;
    crate::tray::open_attendance_window(&app);
    crate::tray::refresh_login_status(&app);
    Ok(())
}

pub(crate) async fn create_mobile_pairing(
    window: WebviewWindow,
    service: tauri::State<'_, Arc<RemoteSyncService>>,
) -> Result<MobilePairing, String> {
    ensure_dashboard_window(&window)?;
    service.create_pairing().await
}

pub(crate) async fn get_mobile_pairing_status(
    window: WebviewWindow,
    service: tauri::State<'_, Arc<RemoteSyncService>>,
    pairing_id: String,
) -> Result<MobilePairingStatus, String> {
    ensure_dashboard_window(&window)?;
    service.pairing_status(&pairing_id).await
}

pub(crate) async fn approve_mobile_pairing(
    window: WebviewWindow,
    service: tauri::State<'_, Arc<RemoteSyncService>>,
    pairing_id: String,
    claim_id: String,
) -> Result<(), String> {
    ensure_dashboard_window(&window)?;
    service.approve_pairing(&pairing_id, &claim_id).await
}

pub(crate) async fn list_mobile_sessions(
    window: WebviewWindow,
    service: tauri::State<'_, Arc<RemoteSyncService>>,
) -> Result<Vec<MobileDevice>, String> {
    ensure_dashboard_window(&window)?;
    service.devices().await
}

pub(crate) async fn revoke_mobile_session(
    window: WebviewWindow,
    service: tauri::State<'_, Arc<RemoteSyncService>>,
    device_id: String,
) -> Result<(), String> {
    ensure_dashboard_window(&window)?;
    service.revoke_device(&device_id).await
}

pub(crate) async fn get_remote_attendance_snapshot(
    window: WebviewWindow,
    service: tauri::State<'_, Arc<RemoteSyncService>>,
) -> Result<RemoteAttendanceEnvelope, String> {
    ensure_dashboard_window(&window)?;
    service.attendance().await
}

pub(crate) async fn refresh_platform_sync(
    app: tauri::AppHandle,
    window: WebviewWindow,
    service: tauri::State<'_, Arc<RemoteSyncService>>,
) -> Result<(), String> {
    ensure_dashboard_window(&window)?;
    if service.current_bearer().await.is_none() {
        return Err(ServiceError::AuthenticationRequired.code().into());
    }
    if app.get_webview_window(CHECKER_WINDOW_LABEL).is_none() {
        return Err("CHECKER_UNAVAILABLE".into());
    }
    let baseline = service.snapshot_revision.load(Ordering::Acquire);
    if !crate::checker::trigger_current_check(&app) {
        return Err("CHECKER_BUSY".into());
    }
    tokio::time::timeout(Duration::from_secs(15), service.wait_for_snapshot_after(baseline))
        .await
        .map_err(|_| "CHECKER_SYNC_TIMEOUT".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{attendance::AttendanceReport, config::Config, secure_credential::MemoryCredentialStore};
    use chrono::TimeZone;

    fn access_cookie(value: &str) -> LmsCookieCandidate {
        LmsCookieCandidate {
            name: "access_token".into(),
            value: value.into(),
            domain: Some("jungle-lms.krafton.com".into()),
            path: Some("/".into()),
            secure: Some(true),
            http_only: Some(true),
            expires: Some(1_900_000_000.0),
            same_site: Some("Lax".into()),
        }
    }

    #[test]
    fn native_cookie_boundary_accepts_one_exact_secure_http_only_access_token() {
        let mut refresh = access_cookie("refresh.secret");
        refresh.name = "refresh_token".into();
        let selected = select_lms_access_cookie(&[refresh, access_cookie("header.payload.signature")])
            .expect("one exact access token");

        assert_eq!(selected.value, "header.payload.signature");
    }

    #[test]
    fn native_cookie_boundary_rejects_missing_ambiguous_or_weakened_tokens() {
        assert!(select_lms_access_cookie(&[]).is_err());
        assert!(select_lms_access_cookie(&[access_cookie("first"), access_cookie("second")]).is_err());

        let mut insecure = access_cookie("secret");
        insecure.secure = Some(false);
        let mut script_readable = access_cookie("secret");
        script_readable.http_only = Some(false);
        let mut parent_domain = access_cookie("secret");
        parent_domain.domain = Some("krafton.com".into());
        let mut subpath = access_cookie("secret");
        subpath.path = Some("/check-in".into());
        let mut header_unsafe = access_cookie("secret; injected=true");
        header_unsafe.domain = Some(".jungle-lms.krafton.com".into());

        for candidate in [insecure, script_readable, parent_domain, subpath, header_unsafe] {
            assert!(select_lms_access_cookie(&[candidate]).is_err());
        }
    }

    #[test]
    fn api_origin_requires_https_except_exact_debug_loopback() {
        assert_eq!(
            normalize_api_origin(" https://bell.example.com/// ", false).unwrap(),
            "https://bell.example.com"
        );
        assert_eq!(
            normalize_api_origin("http://127.0.0.1:8787/", true).unwrap(),
            "http://127.0.0.1:8787"
        );
        for invalid in [
            "http://bell.example.com",
            "http://192.168.0.8:8787",
            "https://user:password@bell.example.com",
            "https://bell.example.com/api?token=x",
            "https://bell.example.com/#fragment",
        ] {
            assert!(normalize_api_origin(invalid, true).is_err(), "{invalid}");
        }
    }

    #[test]
    fn ipc_route_ids_and_pairing_codes_are_closed_allowlists() {
        for valid in ["pair_123", "device-ABC", "550e8400-e29b-41d4-a716-446655440000"] {
            assert!(is_safe_route_segment(valid), "{valid}");
        }
        for invalid in ["", "../device", "a/b", "한글", "x?token=secret", &"x".repeat(129)] {
            assert!(!is_safe_route_segment(invalid), "{invalid}");
        }
        assert!(is_manual_pairing_code("01AHJKMNPZ"));
        for invalid in ["123456789", "12345678901", "12345-6789", "ABCDEFILOU", "abcdefghij"] {
            assert!(!is_manual_pairing_code(invalid), "{invalid}");
        }
    }

    #[test]
    fn mobile_installation_ids_accept_server_ids_but_reject_path_or_control_data() {
        for valid in [
            "550e8400-e29b-41d4-a716-446655440000",
            "jbmi_0123456789abcdef0123456789abcdef",
            "device.mobile:2026",
        ] {
            assert!(is_safe_device_installation_id(valid), "{valid}");
        }
        for invalid in ["short", "../mobile-device", "device/mobile", "mobile?token=x", "모바일"] {
            assert!(!is_safe_device_installation_id(invalid), "{invalid}");
        }
    }

    #[test]
    fn heartbeat_includes_current_attendance_notification_preferences() {
        let heartbeat = Heartbeat {
            lms_session_state: LmsSessionState::Connected,
            app_version: "0.5.0",
            attendance_notifications: AttendanceNotificationPreferences {
                morning: false,
                evening: true,
                skip_sunday: true,
                skip_attendance_date: Some("2026-08-03".into()),
            },
        };
        assert_eq!(
            serde_json::to_value(heartbeat).unwrap(),
            serde_json::json!({
                "lmsSessionState": "connected",
                "appVersion": "0.5.0",
                "attendanceNotifications": {
                    "morning": false,
                    "evening": true,
                    "skipSunday": true,
                    "skipAttendanceDate": "2026-08-03"
                }
            })
        );
    }

    #[test]
    fn remote_attendance_freshness_is_mandatory_and_coherent() {
        let snapshot = AttendanceSnapshot {
            attendance_date: "2026-08-03".into(),
            cohort_id: Some("cohort-1".into()),
            cohort_status: AttendanceCohortStatus::Active,
            cohort_start_date: Some("2026-07-01".into()),
            cohort_end_date: Some("2026-12-31".into()),
            morning_checked: false,
            evening_checked: false,
            collected_at: "2026-08-03T00:00:00.000Z".into(),
        };
        for freshness in [RemoteAttendanceFreshness::Fresh, RemoteAttendanceFreshness::Stale] {
            assert!(validate_remote_attendance(&RemoteAttendanceEnvelope {
                attendance: Some(snapshot.clone()),
                freshness,
            })
            .is_ok());
        }
        assert!(validate_remote_attendance(&RemoteAttendanceEnvelope {
            attendance: None,
            freshness: RemoteAttendanceFreshness::Missing,
        })
        .is_ok());
        assert!(validate_remote_attendance(&RemoteAttendanceEnvelope {
            attendance: Some(snapshot),
            freshness: RemoteAttendanceFreshness::Missing,
        })
        .is_err());
        assert!(serde_json::from_value::<RemoteAttendanceEnvelope>(serde_json::json!({
            "attendance": null
        }))
        .is_err());
    }

    #[test]
    fn pairing_qr_is_bound_to_api_origin_path_pairing_and_one_challenge() {
        let origin = Url::parse("https://bell.example.com").unwrap();
        let pairing_id = "jbp_01234567-89ab-4def-8123-456789abcdef";
        let challenge = format!("jbpc_{}", "a".repeat(64));
        let valid = format!("https://bell.example.com/dashboard.html#pairing={pairing_id}&challenge={challenge}");
        assert!(is_safe_pairing_url(&valid, pairing_id, &origin));

        for invalid in [
            format!("https://evil.example/dashboard.html#pairing={pairing_id}&challenge={challenge}"),
            format!("https://bell.example.com/pair#pairing={pairing_id}&challenge={challenge}"),
            format!("https://bell.example.com/dashboard.html?next=x#pairing={pairing_id}&challenge={challenge}"),
            format!("https://bell.example.com/dashboard.html#pairing=other&challenge={challenge}"),
            format!("https://bell.example.com/dashboard.html#pairing={pairing_id}&challenge={challenge}&next=x"),
            format!("https://bell.example.com/dashboard.html#pairing={pairing_id}&pairing={pairing_id}"),
        ] {
            assert!(!is_safe_pairing_url(&invalid, pairing_id, &origin), "{invalid}");
        }
    }

    #[test]
    fn server_notification_text_is_bounded_and_control_free() {
        assert!(is_safe_notification_text("출석 10분 전입니다.", 80, false));
        assert!(is_safe_notification_text("첫 줄\n둘째 줄", 200, true));
        assert!(!is_safe_notification_text("", 80, false));
        assert!(!is_safe_notification_text(" 앞뒤 공백 ", 80, false));
        assert!(!is_safe_notification_text("줄바꿈\n금지", 80, false));
        assert!(!is_safe_notification_text("x\u{0000}y", 80, true));
        assert!(!is_safe_notification_text(&"가".repeat(81), 80, false));
    }

    #[test]
    fn expired_server_notifications_are_validated_then_discarded() {
        let notification = |id: &str, created_at_epoch_ms: i64, expires_at_epoch_ms: i64| RemoteNotification {
            id: id.into(),
            kind: RemoteNotificationKind::AttendanceActionRequired,
            title: "출석 확인".into(),
            body: "출석 시간이 임박했습니다.".into(),
            path: "/attendance".into(),
            created_at_epoch_ms,
            expires_at_epoch_ms,
            attempt: 1,
        };
        let mut notifications = vec![
            notification("active", 1_000, 3_000),
            notification("expired", 500, 1_500),
        ];
        assert!(validate_notifications(&notifications).is_ok());
        discard_expired_notifications(&mut notifications, 2_000);
        assert_eq!(notifications.len(), 1);
        assert_eq!(notifications[0].id, "active");
        assert!(validate_notifications(&[notification("invalid", 2_000, 1_000)]).is_err());
    }

    #[test]
    fn fallback_requires_server_silence_and_ten_minute_attendance_window() {
        let now = Utc.with_ymd_and_hms(2026, 8, 3, 0, 0, 0).unwrap();
        assert!(fallback_due(
            now,
            Some(now - chrono::Duration::minutes(6)),
            Some(10 * 60)
        ));
        assert!(!fallback_due(
            now,
            Some(now - chrono::Duration::minutes(4)),
            Some(10 * 60)
        ));
        assert!(!fallback_due(
            now,
            Some(now - chrono::Duration::minutes(6)),
            Some(11 * 60)
        ));
        assert!(!fallback_due(now, None, None));
    }

    #[test]
    fn stored_bearer_without_successful_inbox_poll_starts_in_local_fallback() {
        let now = Utc.with_ymd_and_hms(2026, 8, 3, 0, 0, 0).unwrap();
        assert_eq!(
            notification_authority(true, None, now),
            crate::state::AttendanceNotificationAuthority::LocalFallback
        );
        assert_eq!(
            notification_authority(true, Some(now - chrono::Duration::minutes(1)), now),
            crate::state::AttendanceNotificationAuthority::Server
        );
        assert_eq!(
            notification_authority(false, None, now),
            crate::state::AttendanceNotificationAuthority::LegacyLocal
        );
    }

    #[test]
    fn checker_context_requires_the_hidden_window_and_exact_lms_https_origin() {
        assert!(checker_context_is_allowed(
            "checker",
            Some("https://jungle-lms.krafton.com/check-in")
        ));
        for (label, url) in [
            ("dashboard", "https://jungle-lms.krafton.com/check-in"),
            ("checker", "http://jungle-lms.krafton.com/check-in"),
            ("checker", "https://jungle-lms.krafton.com.evil.test/check-in"),
            ("checker", "https://user@jungle-lms.krafton.com/check-in"),
            ("checker", "https://jungle-lms.krafton.com:444/check-in"),
        ] {
            assert!(!checker_context_is_allowed(label, Some(url)), "{label} {url}");
        }
    }

    #[test]
    fn verify_payload_preserves_only_one_normalized_cookie_and_installation_id() {
        let cookie = select_lms_access_cookie(&[access_cookie("header.payload.signature")]).unwrap();
        let request = VerifyLmsRequest {
            installation_id: "550e8400-e29b-41d4-a716-446655440000".into(),
            cookies: vec![cookie],
        };
        let value = serde_json::to_value(request).unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "installationId":"550e8400-e29b-41d4-a716-446655440000",
                "cookies":[{
                    "name":"access_token",
                    "value":"header.payload.signature",
                    "domain":"jungle-lms.krafton.com",
                    "path":"/",
                    "expires":1_900_000_000.0,
                    "httpOnly":true,
                    "secure":true,
                    "sameSite":"Lax"
                }]
            })
        );
        let encoded = value.to_string();
        assert!(!encoded.contains("cmsUserId"));
        assert!(!encoded.contains("lmsUserId"));
    }

    #[test]
    fn app_bearer_is_exact_and_stored_only_through_the_credential_store_contract() {
        let token = format!("jba_{}", "a".repeat(64));
        assert!(is_app_bearer(&token));
        for invalid in [
            format!("jba_{}", "a".repeat(63)),
            format!("jba_{}", "A".repeat(64)),
            format!("jwt.{}", "a".repeat(64)),
            format!("jba_{}", "g".repeat(64)),
        ] {
            assert!(!is_app_bearer(&invalid));
        }

        let store = MemoryCredentialStore::new(None);
        let credential = BearerCredential {
            token: Zeroizing::new(token.clone()),
            expires_at: Utc::now() + chrono::Duration::days(30),
        };
        persist_credential(&store, &credential).unwrap();
        let stored = store.load().unwrap().unwrap();
        let restored = decode_stored_credential(&stored).unwrap();
        assert_eq!(&*restored.token, &token);

        let status = ConnectedServiceStatus {
            authenticated: true,
            installation_id: "550e8400-e29b-41d4-a716-446655440000".into(),
            credential_persistent: true,
            last_server_contact: None,
            last_error: None,
        };
        assert!(!serde_json::to_string(&status).unwrap().contains(&token));
    }

    #[test]
    fn checker_snapshot_upload_is_read_only_and_uses_current_attendance_state() {
        let mut state = AppState::new(Config::default());
        state.effective_cohort_id = Some("cohort-7".into());
        let report = AttendanceReport {
            generation: 3,
            needs_login: false,
            morning_done: true,
            evening_done: false,
            api_error: false,
            cohort_status: CohortReportStatus::Active,
            cohort_start_date: Some("2026-07-01".into()),
            cohort_end_date: Some("2026-08-31".into()),
        };
        let now = Utc.with_ymd_and_hms(2026, 8, 3, 1, 2, 3).unwrap();
        let snapshot = attendance_snapshot_from_checker(&state, &report, now).unwrap();
        assert_eq!(snapshot.attendance_date, "2026-08-03");
        assert_eq!(snapshot.cohort_id.as_deref(), Some("cohort-7"));
        assert!(snapshot.morning_checked);
        assert!(!snapshot.evening_checked);
        assert!(serde_json::to_string(&snapshot).unwrap().contains("morningChecked"));

        let mut login_required = report.clone();
        login_required.needs_login = true;
        assert!(attendance_snapshot_from_checker(&state, &login_required, now).is_none());

        let mut ended = report;
        ended.cohort_status = CohortReportStatus::Ended;
        ended.morning_done = true;
        ended.evening_done = true;
        let ended_snapshot = attendance_snapshot_from_checker(&state, &ended, now).unwrap();
        assert_eq!(ended_snapshot.cohort_id, None);
        assert!(!ended_snapshot.morning_checked);
        assert!(!ended_snapshot.evening_checked);
        assert!(validate_attendance_snapshot(&ended_snapshot).is_ok());
    }

    #[test]
    fn pairing_approval_status_requires_visible_claim_identity() {
        let valid = MobilePairingStatus {
            status: "claimed".into(),
            claim: Some(MobilePairingClaim {
                claim_id: "claim_123".into(),
                device_label: "내 휴대폰".into(),
                confirmation_code: "A1B2".into(),
            }),
        };
        assert!(validate_pairing_status(&valid).is_ok());
        assert!(validate_pairing_status(&MobilePairingStatus {
            status: "claimed".into(),
            claim: None,
        })
        .is_err());
        assert!(validate_pairing_status(&MobilePairingStatus {
            status: "pending".into(),
            claim: valid.claim,
        })
        .is_err());
    }

    #[test]
    fn api_contract_has_no_desktop_automatic_attendance_endpoint() {
        let attendance_mutations = [ATTENDANCE_SNAPSHOT_PATH];
        assert_eq!(attendance_mutations, ["/v1/attendance/snapshot"]);
    }
}
