use std::{
    collections::{HashSet, VecDeque},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU8, Ordering},
        Mutex, OnceLock,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use reqwest::{
    header::{HeaderMap, HeaderValue, CACHE_CONTROL, COOKIE, SET_COOKIE},
    redirect::Policy,
    Client, StatusCode,
};
use serde::Serialize;
use tauri::{
    webview::{Cookie, PageLoadEvent},
    AppHandle, Manager, Url, WebviewWindow,
};
use tokio::sync::Mutex as AsyncMutex;

use crate::{
    agent_protocol::{
        is_safe_route_segment, parse_agent_report, parse_notification_page,
        AttendanceSnapshotUpload, HeartbeatUpload, LmsAgentReport, LmsSessionState,
        NotificationAck, NotificationAckOutcome, NotificationDelivery, NotificationKind,
        NotificationPage,
    },
    installation::{
        delete_subject_binding, load_or_create_installation_id, load_subject_binding,
        store_subject_binding, subject_binding_digest,
    },
    native_notification::show_native_notification,
};

const APP_ORIGIN_ENV: &str = "JB_APP_ORIGIN";
const API_ORIGIN_ENV: &str = "JB_API_ORIGIN";
const DEFAULT_DEBUG_APP_ORIGIN: &str = "http://127.0.0.1:5173";
const DEFAULT_DEBUG_API_ORIGIN: &str = "http://127.0.0.1:8787";
const LMS_HOST: &str = "jungle-lms.krafton.com";
const LMS_ORIGIN: &str = "https://jungle-lms.krafton.com";
const LMS_ENTRY_URL: &str = "https://jungle-lms.krafton.com/check-in";
const LOGIN_WINDOW_LABEL: &str = "lms-login";
const MAIN_WINDOW_LABEL: &str = "main";
const MAIN_PRIVACY_GATE_URL: &str = "about:blank";
const MAX_APP_COOKIE_BYTES: usize = 4_096;
const MAX_NOTIFICATION_RESPONSE_BYTES: u64 = 512 * 1024;
const APP_SESSION_MAX_AGE_SECONDS: i64 = 90 * 24 * 60 * 60;
const APP_COOKIE_VERIFY_ATTEMPTS: usize = 20;
const APP_COOKIE_VERIFY_INTERVAL: Duration = Duration::from_millis(50);
const COLLECTION_INTERVAL: Duration = Duration::from_secs(5 * 60);
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(30);
const NOTIFICATION_INTERVAL: Duration = Duration::from_secs(15);
const DISPLAYED_NOTIFICATION_CACHE_CAPACITY: usize = 256;
const LMS_COLLECTOR_SCRIPT: &str = include_str!("lms_collector.js");
const TRIGGER_LMS_COLLECTION_SCRIPT: &str = r#"
(() => {
  if (window.location.origin !== "https://jungle-lms.krafton.com") return;
  const agent = window.__JUNGLE_BELL_LMS_AGENT__;
  if (agent && typeof agent.collect === "function") void agent.collect();
})();
"#;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LmsCookie {
    name: String,
    value: String,
    domain: String,
    path: String,
    expires: f64,
    http_only: bool,
    secure: bool,
    same_site: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LmsIdentityUpload<'a> {
    desktop_device_id: &'a str,
    subject_binding: &'a str,
    cookies: &'a [LmsCookie],
}

#[derive(Debug, Clone)]
struct PendingRegistration {
    subject: String,
    cookie: Cookie<'static>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AuthenticatedApiError {
    AuthenticationRequired,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NativeNotificationDisposition {
    DeliverAndAcknowledge,
    DeferWithoutAcknowledgement,
}

fn native_notification_disposition(
    subject_verified: bool,
    kind: NotificationKind,
) -> NativeNotificationDisposition {
    if subject_verified || kind == NotificationKind::LoginRequired {
        NativeNotificationDisposition::DeliverAndAcknowledge
    } else {
        NativeNotificationDisposition::DeferWithoutAcknowledgement
    }
}

#[derive(Debug, Clone)]
struct DesktopApi {
    origin: Url,
    client: Client,
}

impl DesktopApi {
    fn new(origin: Url) -> Result<Self, String> {
        let client = Client::builder()
            .redirect(Policy::none())
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(15))
            .https_only(!cfg!(debug_assertions))
            .build()
            .map_err(|_| "NATIVE_HTTP_INIT_FAILED".to_owned())?;
        Ok(Self { origin, client })
    }

    fn endpoint(&self, path: &str) -> Result<Url, String> {
        self.origin
            .join(path)
            .map_err(|_| "API_ORIGIN_INVALID".to_owned())
    }

    async fn onboard(
        &self,
        desktop_device_id: &str,
        subject_binding: &str,
        cookies: &[LmsCookie],
        app_origin: &Url,
        prior_app_cookie: Option<HeaderValue>,
    ) -> Result<Cookie<'static>, String> {
        let request = self
            .client
            .post(self.endpoint("/api/onboarding/lms-identity")?)
            .json(&LmsIdentityUpload {
                desktop_device_id,
                subject_binding,
                cookies,
            });
        let request = if let Some(cookie) = prior_app_cookie {
            request.header(COOKIE, cookie)
        } else {
            request
        };
        let response = request
            .send()
            .await
            .map_err(|_| "SERVER_UNAVAILABLE".to_owned())?;

        validate_onboarding_response(response.status(), response.headers(), app_origin)
    }

    async fn heartbeat(
        &self,
        cookie: HeaderValue,
        session_state: LmsSessionState,
    ) -> Result<(), AuthenticatedApiError> {
        let response = self
            .client
            .post(
                self.endpoint("/api/private/desktop/heartbeat")
                    .map_err(|_| AuthenticatedApiError::Failed)?,
            )
            .header(COOKIE, cookie)
            .json(&HeartbeatUpload {
                lms_session_state: session_state,
                app_version: Some(env!("CARGO_PKG_VERSION")),
            })
            .send()
            .await
            .map_err(|_| AuthenticatedApiError::Failed)?;
        expect_authenticated_status(response.status(), StatusCode::OK)
    }

    async fn attendance_snapshot(
        &self,
        cookie: HeaderValue,
        snapshot: &AttendanceSnapshotUpload,
    ) -> Result<(), AuthenticatedApiError> {
        let response = self
            .client
            .post(
                self.endpoint("/api/private/desktop/attendance-snapshot")
                    .map_err(|_| AuthenticatedApiError::Failed)?,
            )
            .header(COOKIE, cookie)
            .json(snapshot)
            .send()
            .await
            .map_err(|_| AuthenticatedApiError::Failed)?;
        expect_authenticated_status(response.status(), StatusCode::OK)
    }

    async fn notifications(
        &self,
        cookie: HeaderValue,
    ) -> Result<NotificationPage, AuthenticatedApiError> {
        let response = self
            .client
            .get(
                self.endpoint("/api/private/desktop/notifications?limit=20")
                    .map_err(|_| AuthenticatedApiError::Failed)?,
            )
            .header(COOKIE, cookie)
            .send()
            .await
            .map_err(|_| AuthenticatedApiError::Failed)?;
        expect_authenticated_status(response.status(), StatusCode::OK)?;
        if response
            .content_length()
            .is_some_and(|length| length > MAX_NOTIFICATION_RESPONSE_BYTES)
        {
            return Err(AuthenticatedApiError::Failed);
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|_| AuthenticatedApiError::Failed)?;
        if bytes.len() as u64 > MAX_NOTIFICATION_RESPONSE_BYTES {
            return Err(AuthenticatedApiError::Failed);
        }
        let body = std::str::from_utf8(&bytes).map_err(|_| AuthenticatedApiError::Failed)?;
        parse_notification_page(body).map_err(|_| AuthenticatedApiError::Failed)
    }

    async fn acknowledge_notification(
        &self,
        cookie: HeaderValue,
        delivery_id: &str,
        outcome: NotificationAckOutcome,
    ) -> Result<(), AuthenticatedApiError> {
        if !is_safe_route_segment(delivery_id, 128) {
            return Err(AuthenticatedApiError::Failed);
        }
        let path = format!("/api/private/desktop/notifications/{delivery_id}/ack");
        let response = self
            .client
            .post(
                self.endpoint(&path)
                    .map_err(|_| AuthenticatedApiError::Failed)?,
            )
            .header(COOKIE, cookie)
            .json(&NotificationAck {
                outcome,
                occurred_at_epoch_ms: current_epoch_millis(),
            })
            .send()
            .await
            .map_err(|_| AuthenticatedApiError::Failed)?;
        expect_authenticated_status(response.status(), StatusCode::NO_CONTENT)
    }
}

fn expect_authenticated_status(
    actual: StatusCode,
    expected: StatusCode,
) -> Result<(), AuthenticatedApiError> {
    if actual == expected {
        Ok(())
    } else if matches!(
        actual,
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN | StatusCode::CONFLICT
    ) {
        Err(AuthenticatedApiError::AuthenticationRequired)
    } else {
        Err(AuthenticatedApiError::Failed)
    }
}

#[derive(Debug, Default)]
struct DisplayedNotificationCache {
    ids: HashSet<String>,
    order: VecDeque<String>,
}

impl DisplayedNotificationCache {
    fn contains(&self, delivery_id: &str) -> bool {
        self.ids.contains(delivery_id)
    }

    fn remember(&mut self, delivery_id: String) {
        if !self.ids.insert(delivery_id.clone()) {
            return;
        }
        self.order.push_back(delivery_id);
        while self.order.len() > DISPLAYED_NOTIFICATION_CACHE_CAPACITY {
            if let Some(expired) = self.order.pop_front() {
                self.ids.remove(&expired);
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MainPrivacySurface {
    PrivacyGate,
    RemoteApp,
    Hidden,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
enum MainDocument {
    PrivacyGate = 0,
    RemoteApp = 1,
}

#[derive(Debug, Clone, Copy)]
struct MainDocumentSnapshot {
    document: MainDocument,
    ready: bool,
}

#[derive(Debug, Default)]
struct MainPrivacyGate {
    subject_verified: AtomicBool,
    reveal_requested: AtomicBool,
}

impl MainPrivacyGate {
    fn request_reveal(&self) -> MainPrivacySurface {
        self.reveal_requested.store(true, Ordering::Release);
        if self.subject_verified.load(Ordering::Acquire) {
            MainPrivacySurface::RemoteApp
        } else {
            MainPrivacySurface::PrivacyGate
        }
    }

    fn request_hide(&self) {
        self.reveal_requested.store(false, Ordering::Release);
    }

    fn mark_subject_verified(&self) -> MainPrivacySurface {
        self.subject_verified.store(true, Ordering::Release);
        if self.reveal_requested.load(Ordering::Acquire) {
            MainPrivacySurface::RemoteApp
        } else {
            MainPrivacySurface::Hidden
        }
    }

    fn lock_for_subject_reverification(&self) -> MainPrivacySurface {
        self.subject_verified.store(false, Ordering::Release);
        if self.reveal_requested.load(Ordering::Acquire) {
            MainPrivacySurface::PrivacyGate
        } else {
            MainPrivacySurface::Hidden
        }
    }

    fn subject_verified(&self) -> bool {
        self.subject_verified.load(Ordering::Acquire)
    }

    fn reveal_requested(&self) -> bool {
        self.reveal_requested.load(Ordering::Acquire)
    }
}

pub(crate) struct DesktopSessionState {
    api: DesktopApi,
    app_origin: Url,
    installation_id: OnceLock<String>,
    app_data_dir: OnceLock<PathBuf>,
    app_session: Mutex<Option<HeaderValue>>,
    app_cookie_rejected: AtomicBool,
    main_privacy_gate: MainPrivacyGate,
    main_document: AtomicU8,
    main_document_ready: AtomicBool,
    main_command_context_allowed: AtomicBool,
    login_navigation_report_allowed: AtomicBool,
    login_report_context_allowed: AtomicBool,
    identity_retry_used: AtomicBool,
    snapshot_retry_used: AtomicBool,
    onboarding_suspended: AtomicBool,
    unverified_inbox_poll_available: AtomicBool,
    onboarding: AsyncMutex<()>,
    bound_subject_digest: Mutex<Option<String>>,
    lms_session_state: Mutex<LmsSessionState>,
    pending_registration: Mutex<Option<PendingRegistration>>,
    displayed_notifications: Mutex<DisplayedNotificationCache>,
}

impl DesktopSessionState {
    pub(crate) fn configured() -> Result<Self, String> {
        let release = !cfg!(debug_assertions);
        let app_origin = configured_origin(
            APP_ORIGIN_ENV,
            option_env!("JB_APP_ORIGIN"),
            DEFAULT_DEBUG_APP_ORIGIN,
            "PRODUCTION_APP_ORIGIN_MISSING",
            "APP_ORIGIN_INVALID",
        )?;
        let api_origin = configured_origin(
            API_ORIGIN_ENV,
            option_env!("JB_API_ORIGIN"),
            DEFAULT_DEBUG_API_ORIGIN,
            "PRODUCTION_API_ORIGIN_MISSING",
            "API_ORIGIN_INVALID",
        )?;
        validate_origin_pair(&app_origin, &api_origin, release)?;
        Ok(Self {
            api: DesktopApi::new(api_origin)?,
            app_origin,
            installation_id: OnceLock::new(),
            app_data_dir: OnceLock::new(),
            app_session: Mutex::new(None),
            app_cookie_rejected: AtomicBool::new(false),
            main_privacy_gate: MainPrivacyGate::default(),
            main_document: AtomicU8::new(MainDocument::PrivacyGate as u8),
            main_document_ready: AtomicBool::new(false),
            main_command_context_allowed: AtomicBool::new(false),
            login_navigation_report_allowed: AtomicBool::new(false),
            login_report_context_allowed: AtomicBool::new(false),
            identity_retry_used: AtomicBool::new(false),
            snapshot_retry_used: AtomicBool::new(false),
            onboarding_suspended: AtomicBool::new(false),
            unverified_inbox_poll_available: AtomicBool::new(true),
            onboarding: AsyncMutex::new(()),
            bound_subject_digest: Mutex::new(None),
            lms_session_state: Mutex::new(LmsSessionState::Unknown),
            pending_registration: Mutex::new(None),
            displayed_notifications: Mutex::new(DisplayedNotificationCache::default()),
        })
    }

    pub(crate) fn app_origin(&self) -> &Url {
        &self.app_origin
    }

    fn initialize_installation(
        &self,
        installation_id: String,
        app_data_dir: PathBuf,
        subject_binding: Option<String>,
    ) -> Result<(), String> {
        if let Some(existing) = self.installation_id.get() {
            return if existing == &installation_id && self.app_data_dir.get() == Some(&app_data_dir)
            {
                Ok(())
            } else {
                Err("INSTALLATION_ID_ALREADY_INITIALIZED".into())
            };
        }
        self.installation_id
            .set(installation_id)
            .map_err(|_| "INSTALLATION_ID_ALREADY_INITIALIZED".to_owned())?;
        self.app_data_dir
            .set(app_data_dir)
            .map_err(|_| "INSTALLATION_ID_ALREADY_INITIALIZED".to_owned())?;
        *self
            .bound_subject_digest
            .lock()
            .map_err(|_| "LMS_SUBJECT_STATE_FAILED".to_owned())? = subject_binding;
        Ok(())
    }

    fn installation_id(&self) -> Result<&str, String> {
        self.installation_id
            .get()
            .map(String::as_str)
            .ok_or_else(|| "INSTALLATION_ID_UNAVAILABLE".to_owned())
    }

    fn app_session(&self) -> Result<Option<HeaderValue>, String> {
        self.app_session
            .lock()
            .map(|cookie| cookie.clone())
            .map_err(|_| "APP_SESSION_STATE_FAILED".to_owned())
    }

    fn replace_app_session(&self, cookie: Option<HeaderValue>) -> Result<(), String> {
        *self
            .app_session
            .lock()
            .map_err(|_| "APP_SESSION_STATE_FAILED".to_owned())? = cookie;
        Ok(())
    }

    fn subject_matches_binding(&self, subject: &str) -> Result<bool, String> {
        let digest = subject_binding_digest(self.installation_id()?, subject)?;
        self.bound_subject_digest
            .lock()
            .map(|bound| bound.as_deref() == Some(digest.as_str()))
            .map_err(|_| "LMS_SUBJECT_STATE_FAILED".to_owned())
    }

    fn can_reuse_existing_app_session(&self, subject: &str) -> Result<bool, String> {
        Ok(self.verified_session_features_allowed() && self.subject_matches_binding(subject)?)
    }

    fn remember_bound_subject(&self, subject: &str) -> Result<(), String> {
        let digest = subject_binding_digest(self.installation_id()?, subject)?;
        let app_data_dir = self
            .app_data_dir
            .get()
            .ok_or_else(|| "APP_DATA_DIRECTORY_UNAVAILABLE".to_owned())?;
        store_subject_binding(app_data_dir, &digest)?;
        *self
            .bound_subject_digest
            .lock()
            .map_err(|_| "LMS_SUBJECT_STATE_FAILED".to_owned())? = Some(digest);
        self.identity_retry_used.store(false, Ordering::Release);
        Ok(())
    }

    fn clear_bound_subject(&self) -> Result<(), String> {
        let app_data_dir = self
            .app_data_dir
            .get()
            .ok_or_else(|| "APP_DATA_DIRECTORY_UNAVAILABLE".to_owned())?;
        delete_subject_binding(app_data_dir)?;
        *self
            .bound_subject_digest
            .lock()
            .map_err(|_| "LMS_SUBJECT_STATE_FAILED".to_owned())? = None;
        self.lock_for_subject_reverification();
        self.snapshot_retry_used.store(false, Ordering::Release);
        Ok(())
    }

    fn session_state(&self) -> LmsSessionState {
        self.lms_session_state
            .lock()
            .map_or(LmsSessionState::Unknown, |state| *state)
    }

    fn verified_session_features_allowed(&self) -> bool {
        self.main_privacy_gate.subject_verified()
    }

    fn request_main_reveal(&self) -> MainPrivacySurface {
        self.main_privacy_gate.request_reveal()
    }

    fn request_main_hide(&self) {
        self.main_privacy_gate.request_hide();
    }

    fn mark_subject_verified(&self) -> MainPrivacySurface {
        self.main_privacy_gate.mark_subject_verified()
    }

    fn lock_for_subject_reverification(&self) -> MainPrivacySurface {
        self.main_command_context_allowed
            .store(false, Ordering::Release);
        self.unverified_inbox_poll_available
            .store(true, Ordering::Release);
        self.main_privacy_gate.lock_for_subject_reverification()
    }

    fn main_document(&self) -> MainDocument {
        if self.main_document.load(Ordering::Acquire) == MainDocument::RemoteApp as u8 {
            MainDocument::RemoteApp
        } else {
            MainDocument::PrivacyGate
        }
    }

    fn main_document_snapshot(&self) -> MainDocumentSnapshot {
        MainDocumentSnapshot {
            document: self.main_document(),
            ready: self.main_document_ready.load(Ordering::Acquire),
        }
    }

    fn begin_main_navigation(&self, document: MainDocument) {
        self.main_command_context_allowed
            .store(false, Ordering::Release);
        self.main_document_ready.store(false, Ordering::Release);
        self.main_document.store(document as u8, Ordering::Release);
    }

    fn restore_main_document(&self, snapshot: MainDocumentSnapshot) {
        self.main_document
            .store(snapshot.document as u8, Ordering::Release);
        self.main_document_ready
            .store(snapshot.ready, Ordering::Release);
        self.main_command_context_allowed.store(
            snapshot.document == MainDocument::RemoteApp
                && snapshot.ready
                && self.verified_session_features_allowed(),
            Ordering::Release,
        );
    }

    fn record_main_page_load(&self, document: MainDocument, event: PageLoadEvent) -> bool {
        if self.main_document() != document {
            return false;
        }
        let ready = event == PageLoadEvent::Finished;
        self.main_document_ready.store(ready, Ordering::Release);
        self.main_command_context_allowed.store(
            document == MainDocument::RemoteApp && self.verified_session_features_allowed(),
            Ordering::Release,
        );
        true
    }

    fn main_document_is_ready(&self, document: MainDocument) -> bool {
        self.main_document() == document && self.main_document_ready.load(Ordering::Acquire)
    }

    fn main_command_context_allowed(&self) -> bool {
        self.main_command_context_allowed.load(Ordering::Acquire)
    }

    fn record_login_page_load(&self, report_allowed: bool, event: PageLoadEvent) {
        match event {
            PageLoadEvent::Started => {
                self.login_navigation_report_allowed
                    .store(report_allowed, Ordering::Release);
                self.login_report_context_allowed
                    .store(report_allowed, Ordering::Release);
            }
            PageLoadEvent::Finished => {
                self.login_report_context_allowed.store(
                    report_allowed && self.login_navigation_report_allowed.load(Ordering::Acquire),
                    Ordering::Release,
                );
            }
        }
    }

    fn login_report_context_allowed(&self) -> bool {
        self.login_report_context_allowed.load(Ordering::Acquire)
    }

    fn main_reveal_requested(&self) -> bool {
        self.main_privacy_gate.reveal_requested()
    }

    fn heartbeat_request(&self) -> Result<Option<(HeaderValue, LmsSessionState)>, String> {
        if self.app_cookie_rejected.load(Ordering::Acquire)
            || self.onboarding_suspended.load(Ordering::Acquire)
        {
            return Ok(None);
        }
        let Some(cookie) = self.app_session()? else {
            return Ok(None);
        };
        let has_subject_binding = self
            .bound_subject_digest
            .lock()
            .map(|bound| bound.is_some())
            .map_err(|_| "LMS_SUBJECT_STATE_FAILED".to_owned())?;
        let heartbeat_state = heartbeat_state_for_server(
            self.verified_session_features_allowed(),
            has_subject_binding,
            self.session_state(),
        );
        Ok(heartbeat_state.map(|state| (cookie, state)))
    }

    fn notification_request(&self) -> Result<Option<HeaderValue>, String> {
        if self.app_cookie_rejected.load(Ordering::Acquire)
            || self.onboarding_suspended.load(Ordering::Acquire)
        {
            return Ok(None);
        }
        let has_subject_binding = self
            .bound_subject_digest
            .lock()
            .map(|bound| bound.is_some())
            .map_err(|_| "LMS_SUBJECT_STATE_FAILED".to_owned())?;
        if !has_subject_binding {
            return Ok(None);
        }
        if !self.verified_session_features_allowed()
            && !self.unverified_inbox_poll_available.load(Ordering::Acquire)
        {
            return Ok(None);
        }
        self.app_session()
    }

    fn complete_notification_poll(&self, subject_verified: bool) {
        if !subject_verified {
            self.unverified_inbox_poll_available
                .store(false, Ordering::Release);
        }
    }

    fn set_session_state(&self, state: LmsSessionState) {
        if let Ok(mut current) = self.lms_session_state.lock() {
            if state == LmsSessionState::LoginRequired
                && *current != LmsSessionState::LoginRequired
                && !self.verified_session_features_allowed()
            {
                self.unverified_inbox_poll_available
                    .store(true, Ordering::Release);
            }
            *current = state;
        }
    }

    fn pending_registration(&self, subject: &str) -> Result<Option<Cookie<'static>>, String> {
        self.pending_registration
            .lock()
            .map(|pending| {
                pending
                    .as_ref()
                    .filter(|pending| pending.subject == subject)
                    .map(|pending| pending.cookie.clone())
            })
            .map_err(|_| "APP_SESSION_STATE_FAILED".to_owned())
    }

    fn remember_pending_registration(
        &self,
        subject: &str,
        cookie: Cookie<'static>,
    ) -> Result<(), String> {
        *self
            .pending_registration
            .lock()
            .map_err(|_| "APP_SESSION_STATE_FAILED".to_owned())? = Some(PendingRegistration {
            subject: subject.to_owned(),
            cookie,
        });
        Ok(())
    }

    fn clear_pending_registration(&self) {
        if let Ok(mut pending) = self.pending_registration.lock() {
            *pending = None;
        }
    }

    fn notification_was_displayed(&self, delivery_id: &str) -> bool {
        self.displayed_notifications
            .lock()
            .is_ok_and(|cache| cache.contains(delivery_id))
    }

    fn remember_displayed_notification(&self, delivery_id: String) {
        if let Ok(mut cache) = self.displayed_notifications.lock() {
            cache.remember(delivery_id);
        }
    }
}

fn heartbeat_state_for_server(
    subject_verified: bool,
    has_subject_binding: bool,
    current_session_state: LmsSessionState,
) -> Option<LmsSessionState> {
    if !has_subject_binding {
        return None;
    }
    if subject_verified {
        return Some(current_session_state);
    }
    Some(if current_session_state == LmsSessionState::LoginRequired {
        LmsSessionState::LoginRequired
    } else {
        LmsSessionState::Unknown
    })
}

pub(crate) fn main_privacy_gate_url() -> Url {
    Url::parse(MAIN_PRIVACY_GATE_URL).expect("the built-in privacy gate URL must be valid")
}

fn main_document_for_url(candidate: &Url, app_origin: &Url) -> Option<MainDocument> {
    if candidate.as_str() == MAIN_PRIVACY_GATE_URL {
        Some(MainDocument::PrivacyGate)
    } else if is_allowed_main_window(MAIN_WINDOW_LABEL, candidate, app_origin) {
        Some(MainDocument::RemoteApp)
    } else {
        None
    }
}

fn display_main_document(
    app: &AppHandle,
    target: Url,
    document: MainDocument,
    visible: bool,
) -> Result<(), String> {
    let state = app.state::<DesktopSessionState>();
    let main = app
        .get_webview_window(MAIN_WINDOW_LABEL)
        .ok_or_else(|| "MAIN_WINDOW_UNAVAILABLE".to_owned())?;
    if state.main_document() != document {
        let previous = state.main_document_snapshot();
        let _ = main.hide();
        state.begin_main_navigation(document);
        if main.navigate(target).is_err() {
            state.restore_main_document(previous);
            return Err("MAIN_WINDOW_NAVIGATION_FAILED".to_owned());
        }
    }
    if visible && state.main_document_is_ready(document) {
        let _ = main.unminimize();
        let _ = main.show();
        let _ = main.set_focus();
    } else {
        let _ = main.hide();
    }
    Ok(())
}

fn display_privacy_gate(app: &AppHandle, surface: MainPrivacySurface) -> Result<(), String> {
    display_main_document(
        app,
        main_privacy_gate_url(),
        MainDocument::PrivacyGate,
        surface == MainPrivacySurface::PrivacyGate,
    )
}

fn display_verified_app(app: &AppHandle, surface: MainPrivacySurface) -> Result<(), String> {
    let state = app.state::<DesktopSessionState>();
    let origin = state.app_origin().clone();
    display_main_document(
        app,
        origin,
        MainDocument::RemoteApp,
        surface == MainPrivacySurface::RemoteApp,
    )
}

pub(crate) fn record_main_page_load(app: &AppHandle, url: &Url, event: PageLoadEvent) {
    let state = app.state::<DesktopSessionState>();
    let Some(document) = main_document_for_url(url, state.app_origin()) else {
        state
            .main_command_context_allowed
            .store(false, Ordering::Release);
        if let Some(main) = app.get_webview_window(MAIN_WINDOW_LABEL) {
            let _ = main.hide();
        }
        return;
    };
    if !state.record_main_page_load(document, event) {
        return;
    }
    let Some(main) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        return;
    };
    if event == PageLoadEvent::Started {
        if document == MainDocument::PrivacyGate || !state.verified_session_features_allowed() {
            let _ = main.hide();
        }
        return;
    }
    let may_show = state.main_reveal_requested()
        && match document {
            MainDocument::PrivacyGate => !state.verified_session_features_allowed(),
            MainDocument::RemoteApp => state.verified_session_features_allowed(),
        };
    if may_show {
        let _ = main.unminimize();
        let _ = main.show();
        let _ = main.set_focus();
    } else {
        let _ = main.hide();
    }
}

pub(crate) fn record_login_page_load(
    app: &AppHandle,
    label: &str,
    url: &Url,
    event: PageLoadEvent,
) {
    let report_allowed = is_allowed_login_report_window(label, url);
    app.state::<DesktopSessionState>()
        .record_login_page_load(report_allowed, event);
}

pub(crate) fn request_show_main(app: &AppHandle) {
    let state = app.state::<DesktopSessionState>();
    let surface = state.request_main_reveal();
    let display_result = match surface {
        MainPrivacySurface::PrivacyGate => display_privacy_gate(app, surface),
        MainPrivacySurface::RemoteApp => display_verified_app(app, surface),
        MainPrivacySurface::Hidden => Ok(()),
    };
    if display_result.is_err() {
        let _ = app
            .get_webview_window(MAIN_WINDOW_LABEL)
            .map(|main| main.hide());
        return;
    }
    if surface == MainPrivacySurface::PrivacyGate
        && state.session_state() == LmsSessionState::LoginRequired
        && !state.onboarding_suspended.load(Ordering::Acquire)
    {
        show_login_window(app);
    }
}

pub(crate) fn request_hide_main(app: &AppHandle) {
    app.state::<DesktopSessionState>().request_main_hide();
    if let Some(main) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = main.hide();
    }
}

fn lock_main_for_subject_reverification(app: &AppHandle) {
    let surface = app
        .state::<DesktopSessionState>()
        .lock_for_subject_reverification();
    if display_privacy_gate(app, surface).is_err() {
        if let Some(main) = app.get_webview_window(MAIN_WINDOW_LABEL) {
            let _ = main.hide();
        }
    }
}

fn release_main_after_subject_verification(
    app: &AppHandle,
    login_window: &WebviewWindow,
) -> Result<(), String> {
    let state = app.state::<DesktopSessionState>();
    let surface = state.mark_subject_verified();
    if let Err(error) = display_verified_app(app, surface) {
        let gate_surface = state.lock_for_subject_reverification();
        let _ = display_privacy_gate(app, gate_surface);
        return Err(error);
    }
    let _ = login_window.set_skip_taskbar(true);
    let _ = login_window.hide();
    Ok(())
}

fn show_login_window(app: &AppHandle) {
    if let Some(login) = app.get_webview_window(LOGIN_WINDOW_LABEL) {
        let _ = login.set_skip_taskbar(false);
        let _ = login.unminimize();
        let _ = login.show();
        let _ = login.set_focus();
    }
}

pub(crate) fn initialize_local_agent(app: &tauri::App) -> Result<(), String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "APP_DATA_DIRECTORY_UNAVAILABLE".to_owned())?;
    let installation_id = load_or_create_installation_id(&app_data_dir)?;
    let subject_binding = load_subject_binding(&app_data_dir)?;
    app.state::<DesktopSessionState>().initialize_installation(
        installation_id,
        app_data_dir,
        subject_binding,
    )?;
    build_persistent_lms_window(app)?;
    spawn_app_session_bootstrap(app.handle().clone());
    spawn_collection_loop(app.handle().clone());
    spawn_heartbeat_loop(app.handle().clone());
    spawn_notification_loop(app.handle().clone());
    Ok(())
}

fn spawn_app_session_bootstrap(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(250)).await;
        let state = app.state::<DesktopSessionState>();
        let _onboarding = state.onboarding.lock().await;
        if state.app_cookie_rejected.load(Ordering::Acquire)
            || state.onboarding_suspended.load(Ordering::Acquire)
        {
            return;
        }
        let Some(main) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
            return;
        };
        let Ok(Some(cookie)) =
            current_app_cookie_from_main_window(main, state.app_origin().clone()).await
        else {
            return;
        };
        if !state.app_cookie_rejected.load(Ordering::Acquire)
            && !state.onboarding_suspended.load(Ordering::Acquire)
        {
            let _ = state.replace_app_session(Some(cookie));
        }
    });
}

fn build_persistent_lms_window(app: &tauri::App) -> Result<WebviewWindow, String> {
    let target = Url::parse(LMS_ENTRY_URL).map_err(|_| "LMS_LOGIN_URL_INVALID".to_owned())?;
    tauri::WebviewWindowBuilder::new(app, LOGIN_WINDOW_LABEL, tauri::WebviewUrl::External(target))
        .title("Jungle Bell LMS 로그인")
        .inner_size(980.0, 760.0)
        .center()
        .visible(false)
        .focused(false)
        .skip_taskbar(true)
        .devtools(false)
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .on_page_load(|window, payload| {
            record_login_page_load(
                window.app_handle(),
                window.label(),
                payload.url(),
                payload.event(),
            );
        })
        .initialization_script(LMS_COLLECTOR_SCRIPT)
        .build()
        .map_err(|_| "LMS_LOGIN_WINDOW_FAILED".to_owned())
}

fn spawn_collection_loop(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(COLLECTION_INTERVAL).await;
            trigger_lms_collection(&app);
        }
    });
}

fn spawn_heartbeat_loop(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(5)).await;
        loop {
            {
                let state = app.state::<DesktopSessionState>();
                let _onboarding = state.onboarding.lock().await;
                if let Ok(Some((cookie, heartbeat_state))) = state.heartbeat_request() {
                    match state.api.heartbeat(cookie, heartbeat_state).await {
                        Ok(()) | Err(AuthenticatedApiError::Failed) => {}
                        Err(AuthenticatedApiError::AuthenticationRequired) => {
                            invalidate_app_session(&app).await;
                        }
                    }
                }
            }
            tokio::time::sleep(HEARTBEAT_INTERVAL).await;
        }
    });
}

fn spawn_notification_loop(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(5)).await;
        loop {
            poll_notifications(&app).await;
            tokio::time::sleep(NOTIFICATION_INTERVAL).await;
        }
    });
}

async fn poll_notifications(app: &tauri::AppHandle) {
    let state = app.state::<DesktopSessionState>();
    let _onboarding = state.onboarding.lock().await;
    let subject_verified = state.verified_session_features_allowed();
    let Ok(Some(cookie)) = state.notification_request() else {
        return;
    };
    let page = match state.api.notifications(cookie.clone()).await {
        Ok(page) => page,
        Err(AuthenticatedApiError::AuthenticationRequired) => {
            invalidate_app_session(app).await;
            return;
        }
        Err(AuthenticatedApiError::Failed) => return,
    };
    state.complete_notification_poll(subject_verified);

    for delivery in page.notifications {
        if native_notification_disposition(subject_verified, delivery.kind)
            == NativeNotificationDisposition::DeferWithoutAcknowledgement
        {
            continue;
        }
        let already_displayed = state.notification_was_displayed(&delivery.delivery_id);
        let outcome = if already_displayed {
            NotificationAckOutcome::Displayed
        } else if show_delivery(app, &delivery).await.is_ok() {
            state.remember_displayed_notification(delivery.delivery_id.clone());
            NotificationAckOutcome::Displayed
        } else {
            NotificationAckOutcome::Failed
        };
        match state
            .api
            .acknowledge_notification(cookie.clone(), &delivery.delivery_id, outcome)
            .await
        {
            Ok(()) | Err(AuthenticatedApiError::Failed) => {}
            Err(AuthenticatedApiError::AuthenticationRequired) => {
                invalidate_app_session(app).await;
                return;
            }
        }
    }
}

async fn show_delivery(
    app: &tauri::AppHandle,
    delivery: &NotificationDelivery,
) -> Result<(), String> {
    show_native_notification(app, &delivery.title, &delivery.body).await
}

fn trigger_lms_collection(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window(LOGIN_WINDOW_LABEL) {
        let _ = window.eval(TRIGGER_LMS_COLLECTION_SCRIPT);
    }
}

fn retry_identity_collection_once(app: &tauri::AppHandle, error: &str) {
    if error != "LMS_SESSION_REJECTED" {
        return;
    }
    let state = app.state::<DesktopSessionState>();
    if state.identity_retry_used.swap(true, Ordering::AcqRel) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(1)).await;
        trigger_lms_collection(&app);
    });
}

fn retry_snapshot_upload_once(app: &tauri::AppHandle, error: &str) {
    let state = app.state::<DesktopSessionState>();
    if !mark_snapshot_retry_if_allowed(&state.snapshot_retry_used, error) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(5)).await;
        trigger_lms_collection(&app);
    });
}

fn mark_snapshot_retry_if_allowed(retry_used: &AtomicBool, error: &str) -> bool {
    error == "ATTENDANCE_SNAPSHOT_FAILED" && !retry_used.swap(true, Ordering::AcqRel)
}

fn update_tray_session_state(app: &tauri::AppHandle, state: LmsSessionState) {
    let tooltip = match state {
        LmsSessionState::Connected => "Jungle Bell · LMS 연결됨",
        LmsSessionState::LoginRequired => "Jungle Bell · LMS 로그인 필요",
        LmsSessionState::Unknown => "Jungle Bell · LMS 확인 중",
    };
    if let Some(tray) = app.tray_by_id("main-tray") {
        let _ = tray.set_tooltip(Some(tooltip));
    }
}

async fn ensure_app_session(
    app: &tauri::AppHandle,
    login_window: &WebviewWindow,
    subject: &str,
) -> Result<HeaderValue, String> {
    let state = app.state::<DesktopSessionState>();
    let _onboarding = state.onboarding.lock().await;
    if state.onboarding_suspended.load(Ordering::Acquire) {
        return Err("DESKTOP_SESSION_LOGGED_OUT".into());
    }
    let app_session_can_be_reused = state.can_reuse_existing_app_session(subject)?;

    if !app_session_can_be_reused {
        lock_main_for_subject_reverification(app);
    }

    if app_session_can_be_reused {
        if let Some(cookie) = state.app_session()? {
            state.remember_bound_subject(subject)?;
            release_main_after_subject_verification(app, login_window)?;
            return Ok(cookie);
        }
        if !state.app_cookie_rejected.load(Ordering::Acquire) {
            let main = app
                .get_webview_window(MAIN_WINDOW_LABEL)
                .ok_or_else(|| "MAIN_WINDOW_UNAVAILABLE".to_owned())?;
            if let Some(cookie) =
                current_app_cookie_from_main_window(main, state.app_origin().clone()).await?
            {
                state.replace_app_session(Some(cookie.clone()))?;
                state.remember_bound_subject(subject)?;
                release_main_after_subject_verification(app, login_window)?;
                return Ok(cookie);
            }
        }
    }

    let main = app
        .get_webview_window(MAIN_WINDOW_LABEL)
        .ok_or_else(|| "MAIN_WINDOW_UNAVAILABLE".to_owned())?;
    let prior_app_cookie = state.app_session()?;
    let issued = if let Some(pending) = state.pending_registration(subject)? {
        pending
    } else {
        let cookies = cookies_from_login_window(login_window.clone()).await?;
        let subject_binding = subject_binding_digest(state.installation_id()?, subject)?;
        let issued = state
            .api
            .onboard(
                state.installation_id()?,
                &subject_binding,
                &cookies,
                state.app_origin(),
                prior_app_cookie,
            )
            .await?;
        state.remember_pending_registration(subject, issued.clone())?;
        issued
    };

    install_and_verify_app_cookie(main.clone(), state.app_origin().clone(), issued).await?;
    let installed = current_app_cookie_from_main_window(main.clone(), state.app_origin().clone())
        .await?
        .ok_or_else(|| "APP_SESSION_COOKIE_VERIFY_FAILED".to_owned())?;
    state.replace_app_session(Some(installed.clone()))?;
    state.remember_bound_subject(subject)?;
    state.app_cookie_rejected.store(false, Ordering::Release);
    state.clear_pending_registration();
    release_main_after_subject_verification(app, login_window)?;
    Ok(installed)
}

async fn invalidate_app_session(app: &tauri::AppHandle) {
    {
        let state = app.state::<DesktopSessionState>();
        let _ = state.replace_app_session(None);
        state.app_cookie_rejected.store(true, Ordering::Release);
        state.lock_for_subject_reverification();
        state.clear_pending_registration();
    }
    lock_main_for_subject_reverification(app);
    if let Some(main) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let app_origin = {
            let state = app.state::<DesktopSessionState>();
            state.app_origin().clone()
        };
        let _ = delete_app_cookie_from_main_window(main, app_origin).await;
    }
    trigger_lms_collection(app);
}

async fn post_snapshot_with_one_reauthentication(
    app: &tauri::AppHandle,
    login_window: &WebviewWindow,
    subject: &str,
    snapshot: &AttendanceSnapshotUpload,
) -> Result<(), String> {
    let state = app.state::<DesktopSessionState>();
    let cookie = ensure_app_session(app, login_window, subject).await?;
    if !state.verified_session_features_allowed() {
        return Err("LMS_SUBJECT_NOT_VERIFIED".into());
    }
    match state.api.attendance_snapshot(cookie, snapshot).await {
        Ok(()) => Ok(()),
        Err(AuthenticatedApiError::Failed) => Err("ATTENDANCE_SNAPSHOT_FAILED".into()),
        Err(AuthenticatedApiError::AuthenticationRequired) => {
            invalidate_app_session(app).await;
            let cookie = ensure_app_session(app, login_window, subject).await?;
            if !state.verified_session_features_allowed() {
                return Err("LMS_SUBJECT_NOT_VERIFIED".into());
            }
            state
                .api
                .attendance_snapshot(cookie, snapshot)
                .await
                .map_err(|_| "ATTENDANCE_SNAPSHOT_FAILED".to_owned())
        }
    }
}

#[tauri::command]
pub(crate) async fn report_lms_agent_event(
    window: WebviewWindow,
    state: tauri::State<'_, DesktopSessionState>,
    report: String,
) -> Result<(), String> {
    ensure_allowed_login_report_window(&window, &state)?;
    let report = parse_agent_report(&report).inspect_err(|_| {
        eprintln!("lms-collector stage=Report reason=ProtocolRejected");
    })?;
    let app = window.app_handle().clone();
    match report {
        LmsAgentReport::LoginRequired(_) => {
            state.set_session_state(LmsSessionState::LoginRequired);
            update_tray_session_state(&app, LmsSessionState::LoginRequired);
            if !state.verified_session_features_allowed()
                && state.main_reveal_requested()
                && !state.onboarding_suspended.load(Ordering::Acquire)
            {
                show_login_window(&app);
            }
            Ok(())
        }
        LmsAgentReport::CollectorDiagnostic(report) => {
            eprintln!(
                "lms-collector stage={:?} reason={:?}",
                report.stage, report.reason
            );
            Ok(())
        }
        LmsAgentReport::SessionConnected(report) => {
            state.set_session_state(LmsSessionState::Connected);
            update_tray_session_state(&app, LmsSessionState::Connected);
            let result = ensure_app_session(&app, &window, &report.subject)
                .await
                .map(|_| ());
            if let Err(error) = &result {
                retry_identity_collection_once(&app, error);
            }
            result
        }
        LmsAgentReport::Connected(report) => {
            state.set_session_state(LmsSessionState::Connected);
            update_tray_session_state(&app, LmsSessionState::Connected);
            let subject = report.subject.clone();
            let snapshot = AttendanceSnapshotUpload::from(report);
            let result =
                post_snapshot_with_one_reauthentication(&app, &window, &subject, &snapshot).await;
            match &result {
                Ok(()) => {
                    state.snapshot_retry_used.store(false, Ordering::Release);
                }
                Err(error) => {
                    eprintln!(
                        "lms-collector stage=Report reason=UploadFailed class={}",
                        collector_upload_error_class(error)
                    );
                    retry_identity_collection_once(&app, error);
                    retry_snapshot_upload_once(&app, error);
                }
            }
            result
        }
    }
}

fn collector_upload_error_class(error: &str) -> &'static str {
    match error {
        "ATTENDANCE_SNAPSHOT_FAILED" => "attendance-snapshot",
        "LMS_SUBJECT_NOT_VERIFIED" => "subject-verification",
        "LMS_SESSION_REJECTED" => "session-rejected",
        "DESKTOP_SESSION_LOGGED_OUT" => "desktop-session-logged-out",
        "APP_SESSION_COOKIE_VERIFY_FAILED" => "app-cookie-verification",
        "MAIN_WINDOW_UNAVAILABLE" | "MAIN_WINDOW_NAVIGATION_FAILED" => "main-window",
        _ => "other",
    }
}

#[tauri::command]
pub(crate) async fn start_lms_login(
    window: WebviewWindow,
    state: tauri::State<'_, DesktopSessionState>,
) -> Result<(), String> {
    ensure_allowed_main_window(&window, &state)?;
    open_lms_login(window.app_handle()).await
}

pub(crate) async fn open_lms_login(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<DesktopSessionState>();
    let _onboarding = state.onboarding.lock().await;
    state.onboarding_suspended.store(false, Ordering::Release);
    state.identity_retry_used.store(false, Ordering::Release);
    lock_main_for_subject_reverification(app);
    let target = Url::parse(LMS_ENTRY_URL).map_err(|_| "LMS_LOGIN_URL_INVALID".to_owned())?;
    let login = app
        .get_webview_window(LOGIN_WINDOW_LABEL)
        .ok_or_else(|| "LMS_LOGIN_WINDOW_UNAVAILABLE".to_owned())?;
    login
        .navigate(target)
        .map_err(|_| "LMS_LOGIN_WINDOW_FAILED".to_owned())?;
    let _ = login.set_skip_taskbar(false);
    let _ = login.unminimize();
    let _ = login.show();
    let _ = login.set_focus();
    Ok(())
}

#[tauri::command]
pub(crate) async fn clear_local_desktop_session(
    window: WebviewWindow,
    state: tauri::State<'_, DesktopSessionState>,
) -> Result<(), String> {
    ensure_allowed_main_window(&window, &state)?;
    let _onboarding = state.onboarding.lock().await;
    let app = window.app_handle().clone();
    state.onboarding_suspended.store(true, Ordering::Release);
    state.app_cookie_rejected.store(true, Ordering::Release);
    state.replace_app_session(None)?;
    state.clear_pending_registration();
    state.clear_bound_subject()?;
    state.set_session_state(LmsSessionState::LoginRequired);
    lock_main_for_subject_reverification(&app);

    let app_cookie_result =
        delete_app_cookie_from_main_window(window, state.app_origin().clone()).await;
    let lms_cookie_result = if let Some(login) = app.get_webview_window(LOGIN_WINDOW_LABEL) {
        match delete_lms_auth_cookies(login.clone()).await {
            Ok(()) => {
                let target =
                    Url::parse(LMS_ENTRY_URL).map_err(|_| "LMS_LOGIN_URL_INVALID".to_owned())?;
                login
                    .navigate(target)
                    .map_err(|_| "LMS_LOGIN_WINDOW_FAILED".to_owned())?;
                let _ = login.set_skip_taskbar(true);
                let _ = login.hide();
                Ok(())
            }
            Err(error) => Err(error),
        }
    } else {
        Err("LMS_LOGIN_WINDOW_UNAVAILABLE".into())
    };
    update_tray_session_state(&app, LmsSessionState::LoginRequired);
    app_cookie_result?;
    lms_cookie_result
}

fn configured_origin(
    runtime_name: &str,
    build_value: Option<&str>,
    debug_default: &str,
    release_missing: &str,
    invalid: &str,
) -> Result<Url, String> {
    #[cfg(debug_assertions)]
    let runtime_value = std::env::var(runtime_name).ok();
    #[cfg(not(debug_assertions))]
    let runtime_value = {
        let _ = runtime_name;
        None
    };
    let release = !cfg!(debug_assertions);
    let raw = select_origin_value(runtime_value, build_value, debug_default, release)
        .ok_or_else(|| release_missing.to_owned())?;
    normalize_origin(&raw, release, invalid)
}

fn select_origin_value(
    runtime_value: Option<String>,
    build_value: Option<&str>,
    debug_default: &str,
    release: bool,
) -> Option<String> {
    if release {
        build_value.map(str::to_owned)
    } else {
        runtime_value
            .or_else(|| build_value.map(str::to_owned))
            .or_else(|| Some(debug_default.to_owned()))
    }
}

fn normalize_origin(raw: &str, release: bool, invalid: &str) -> Result<Url, String> {
    let mut url = Url::parse(raw).map_err(|_| invalid.to_owned())?;
    let host = url.host_str().ok_or_else(|| invalid.to_owned())?;
    let loopback = is_loopback_host(host);
    let scheme_allowed =
        url.scheme() == "https" || (!release && url.scheme() == "http" && loopback);
    if !scheme_allowed
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !matches!(url.path(), "" | "/")
    {
        return Err(invalid.to_owned());
    }
    url.set_path("/");
    Ok(url)
}

fn is_loopback_host(host: &str) -> bool {
    host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback())
}

pub(crate) fn is_exact_remote_origin(candidate: &Url, trusted: &Url) -> bool {
    candidate.username().is_empty()
        && candidate.password().is_none()
        && candidate.scheme() == trusted.scheme()
        && candidate.host_str() == trusted.host_str()
        && candidate.port_or_known_default() == trusted.port_or_known_default()
}

fn validate_origin_pair(app_origin: &Url, api_origin: &Url, release: bool) -> Result<(), String> {
    if !release || is_exact_remote_origin(api_origin, app_origin) {
        Ok(())
    } else {
        Err("PRODUCTION_ORIGIN_MISMATCH".into())
    }
}

fn is_allowed_main_window(label: &str, url: &Url, app_origin: &Url) -> bool {
    label == MAIN_WINDOW_LABEL && is_exact_remote_origin(url, app_origin)
}

pub(crate) fn ensure_allowed_main_window(
    window: &WebviewWindow,
    state: &DesktopSessionState,
) -> Result<(), String> {
    if window.label() == MAIN_WINDOW_LABEL && state.main_command_context_allowed() {
        Ok(())
    } else {
        Err("COMMAND_CONTEXT_DENIED".into())
    }
}

fn is_allowed_login_report_window(label: &str, url: &Url) -> bool {
    label == LOGIN_WINDOW_LABEL
        && url.scheme() == "https"
        && url.host_str() == Some(LMS_HOST)
        && url.port_or_known_default() == Some(443)
        && url.username().is_empty()
        && url.password().is_none()
}

fn ensure_allowed_login_report_window(
    window: &WebviewWindow,
    state: &DesktopSessionState,
) -> Result<(), String> {
    if window.label() == LOGIN_WINDOW_LABEL && state.login_report_context_allowed() {
        Ok(())
    } else {
        Err("COMMAND_CONTEXT_DENIED".into())
    }
}

fn collect_lms_cookies(cookies: &[Cookie<'static>]) -> Result<Vec<LmsCookie>, String> {
    let mut result = cookies
        .iter()
        .filter(|cookie| cookie.name() == "access_token")
        .filter_map(normalize_lms_cookie)
        .collect::<Vec<_>>();
    result.sort_by(|left, right| left.name.cmp(&right.name));
    result.dedup_by(|left, right| left.name == right.name);
    if result.len() != 1 {
        return Err("LMS_ACCESS_COOKIE_MISSING".into());
    }
    Ok(result)
}

fn normalize_lms_cookie(cookie: &Cookie<'static>) -> Option<LmsCookie> {
    let domain = cookie
        .domain()
        .unwrap_or(LMS_HOST)
        .trim_start_matches('.')
        .to_ascii_lowercase();
    let value_is_header_safe = !cookie.value().is_empty()
        && cookie.value().len() <= 8_192
        && cookie
            .value()
            .bytes()
            .all(|byte| matches!(byte, 0x21..=0x3a | 0x3c..=0x5b | 0x5d..=0x7e));
    if domain != LMS_HOST
        || cookie.path().unwrap_or("/") != "/"
        || cookie.secure() != Some(true)
        || cookie.http_only() != Some(true)
        || !value_is_header_safe
    {
        return None;
    }
    let same_site = cookie
        .same_site()
        .map(|value| format!("{value:?}"))
        .filter(|value| matches!(value.as_str(), "Strict" | "Lax" | "None"))
        .unwrap_or_else(|| "Lax".into());
    Some(LmsCookie {
        name: cookie.name().to_owned(),
        value: cookie.value().to_owned(),
        domain,
        path: "/".into(),
        expires: cookie
            .expires_datetime()
            .map_or(-1.0, |value| value.unix_timestamp() as f64),
        http_only: true,
        secure: true,
        same_site,
    })
}

async fn cookies_from_login_window(window: WebviewWindow) -> Result<Vec<LmsCookie>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let target = Url::parse(LMS_ORIGIN).map_err(|_| "LMS_COOKIE_READ_FAILED".to_owned())?;
        let cookies = window
            .cookies_for_url(target)
            .map_err(|_| "LMS_COOKIE_READ_FAILED".to_owned())?;
        collect_lms_cookies(&cookies)
    })
    .await
    .map_err(|_| "LMS_COOKIE_READ_FAILED".to_owned())?
}

fn expected_app_cookie_name(app_origin: &Url) -> &'static str {
    if app_origin.host_str().is_some_and(is_loopback_host) {
        "jb_app"
    } else {
        "__Secure-jb_app"
    }
}

fn cache_control_has_no_store(headers: &HeaderMap) -> bool {
    headers
        .get_all(CACHE_CONTROL)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .any(|directive| directive.trim().eq_ignore_ascii_case("no-store"))
}

fn app_cookie_matches_contract(cookie: &Cookie<'_>, app_origin: &Url) -> bool {
    let Some(expected_domain) = app_origin.host_str() else {
        return false;
    };
    let domain_matches = cookie
        .domain()
        .is_some_and(|domain| domain.eq_ignore_ascii_case(expected_domain));
    app_cookie_attributes_match(cookie, app_origin, domain_matches)
        && cookie
            .max_age()
            .is_some_and(|max_age| max_age.whole_seconds() == APP_SESSION_MAX_AGE_SECONDS)
}

fn installed_cookie_domain_matches(domain: Option<&str>, expected_domain: &str) -> bool {
    domain.is_some_and(|domain| {
        domain.eq_ignore_ascii_case(expected_domain)
            || domain.strip_prefix('.').is_some_and(|without_prefix| {
                !without_prefix.starts_with('.')
                    && without_prefix.eq_ignore_ascii_case(expected_domain)
            })
    })
}

fn installed_app_cookie_matches_contract(cookie: &Cookie<'_>, app_origin: &Url) -> bool {
    let Some(expected_domain) = app_origin.host_str() else {
        return false;
    };
    app_cookie_attributes_match(
        cookie,
        app_origin,
        installed_cookie_domain_matches(cookie.domain(), expected_domain),
    )
}

fn app_cookie_attributes_match(
    cookie: &Cookie<'_>,
    app_origin: &Url,
    domain_matches: bool,
) -> bool {
    let Some(expected_domain) = app_origin.host_str() else {
        return false;
    };
    let loopback = is_loopback_host(expected_domain);
    let value_is_safe = !cookie.value().is_empty()
        && cookie.value().len() <= MAX_APP_COOKIE_BYTES
        && cookie
            .value()
            .bytes()
            .all(|byte| matches!(byte, 0x21..=0x7e) && byte != b';');
    cookie.name() == expected_app_cookie_name(app_origin)
        && domain_matches
        && cookie.path() == Some("/")
        && cookie.http_only() == Some(true)
        && cookie.same_site() == Some(tauri::webview::cookie::SameSite::Strict)
        && if loopback {
            cookie.secure() != Some(true)
        } else {
            cookie.secure() == Some(true)
        }
        && value_is_safe
}

fn current_app_cookie_header(
    cookies: &[Cookie<'static>],
    app_origin: &Url,
) -> Result<Option<HeaderValue>, String> {
    let mut matches = cookies
        .iter()
        .filter(|cookie| installed_app_cookie_matches_contract(cookie, app_origin));
    let Some(cookie) = matches.next() else {
        return Ok(None);
    };
    if matches.next().is_some() {
        return Err("APP_SESSION_COOKIE_AMBIGUOUS".into());
    }
    let encoded = format!("{}={}", cookie.name(), cookie.value());
    let mut header =
        HeaderValue::from_str(&encoded).map_err(|_| "APP_SESSION_COOKIE_INVALID".to_owned())?;
    header.set_sensitive(true);
    Ok(Some(header))
}

fn wait_for_app_cookie<F>(
    mut read_cookies: F,
    app_origin: &Url,
    expected_value: &str,
    attempts: usize,
    retry_interval: Duration,
) -> Result<(), String>
where
    F: FnMut() -> Result<Vec<Cookie<'static>>, String>,
{
    for attempt in 0..attempts {
        let installed = read_cookies()?;
        if installed.iter().any(|candidate| {
            candidate.value() == expected_value
                && installed_app_cookie_matches_contract(candidate, app_origin)
        }) {
            return Ok(());
        }
        #[cfg(debug_assertions)]
        if attempt + 1 == attempts {
            let expected_name = expected_app_cookie_name(app_origin);
            let named = installed
                .iter()
                .filter(|candidate| candidate.name() == expected_name)
                .collect::<Vec<_>>();
            eprintln!(
                "app-cookie-verify total={} named={} value-match={} contract-match={}",
                installed.len(),
                named.len(),
                named
                    .iter()
                    .any(|candidate| candidate.value() == expected_value),
                named
                    .iter()
                    .any(|candidate| installed_app_cookie_matches_contract(candidate, app_origin))
            );
            for candidate in named {
                eprintln!(
                    "app-cookie-verify-candidate domain={:?} path={:?} http-only={:?} secure={:?} same-site={:?}",
                    candidate.domain(),
                    candidate.path(),
                    candidate.http_only(),
                    candidate.secure(),
                    candidate.same_site()
                );
            }
        }
        if attempt + 1 < attempts {
            std::thread::sleep(retry_interval);
        }
    }
    Err("APP_SESSION_COOKIE_VERIFY_FAILED".into())
}

fn validate_onboarding_response(
    status: StatusCode,
    headers: &HeaderMap,
    app_origin: &Url,
) -> Result<Cookie<'static>, String> {
    if status != StatusCode::NO_CONTENT {
        return Err(match status {
            StatusCode::UNAUTHORIZED => "LMS_SESSION_REJECTED",
            StatusCode::TOO_MANY_REQUESTS => "LMS_LOGIN_RATE_LIMITED",
            _ => "LMS_ONBOARDING_FAILED",
        }
        .into());
    }
    if !cache_control_has_no_store(headers) {
        return Err("LMS_ONBOARDING_CACHE_POLICY_INVALID".into());
    }
    let set_cookies = headers.get_all(SET_COOKIE).iter().collect::<Vec<_>>();
    if set_cookies.len() != 1 {
        return Err("APP_SESSION_COOKIE_INVALID".into());
    }
    let encoded = set_cookies[0]
        .to_str()
        .map_err(|_| "APP_SESSION_COOKIE_INVALID".to_owned())?;
    let cookie = Cookie::parse(encoded.to_owned())
        .map(Cookie::into_owned)
        .map_err(|_| "APP_SESSION_COOKIE_INVALID".to_owned())?;
    if !app_cookie_matches_contract(&cookie, app_origin) {
        return Err("APP_SESSION_COOKIE_INVALID".into());
    }
    Ok(cookie)
}

async fn current_app_cookie_from_main_window(
    main: WebviewWindow,
    app_origin: Url,
) -> Result<Option<HeaderValue>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let cookies = main
            .cookies()
            .map_err(|_| "APP_SESSION_COOKIE_READ_FAILED".to_owned())?;
        current_app_cookie_header(&cookies, &app_origin)
    })
    .await
    .map_err(|_| "APP_SESSION_COOKIE_READ_FAILED".to_owned())?
}

async fn install_and_verify_app_cookie(
    main: WebviewWindow,
    app_origin: Url,
    cookie: Cookie<'static>,
) -> Result<(), String> {
    let expected_value = cookie.value().to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        main.set_cookie(cookie)
            .map_err(|_| "APP_SESSION_COOKIE_INSTALL_FAILED".to_owned())?;
        wait_for_app_cookie(
            || {
                main.cookies()
                    .map_err(|_| "APP_SESSION_COOKIE_VERIFY_FAILED".to_owned())
            },
            &app_origin,
            &expected_value,
            APP_COOKIE_VERIFY_ATTEMPTS,
            APP_COOKIE_VERIFY_INTERVAL,
        )
    })
    .await
    .map_err(|_| "APP_SESSION_COOKIE_INSTALL_FAILED".to_owned())?
}

async fn delete_app_cookie_from_main_window(
    main: WebviewWindow,
    app_origin: Url,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let cookies = main
            .cookies()
            .map_err(|_| "APP_SESSION_COOKIE_READ_FAILED".to_owned())?;
        for cookie in cookies
            .into_iter()
            .filter(|cookie| installed_app_cookie_matches_contract(cookie, &app_origin))
        {
            main.delete_cookie(cookie)
                .map_err(|_| "APP_SESSION_COOKIE_DELETE_FAILED".to_owned())?;
        }
        Ok(())
    })
    .await
    .map_err(|_| "APP_SESSION_COOKIE_DELETE_FAILED".to_owned())?
}

async fn delete_lms_auth_cookies(window: WebviewWindow) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        for cookie in lms_auth_cookies_from_window(&window)? {
            window
                .delete_cookie(cookie)
                .map_err(|_| "LMS_COOKIE_DELETE_FAILED".to_owned())?;
        }
        for attempt in 0..APP_COOKIE_VERIFY_ATTEMPTS {
            if lms_auth_cookies_from_window(&window)?.is_empty() {
                return Ok(());
            }
            if attempt + 1 < APP_COOKIE_VERIFY_ATTEMPTS {
                std::thread::sleep(APP_COOKIE_VERIFY_INTERVAL);
            }
        }
        Err("LMS_COOKIE_DELETE_FAILED".into())
    })
    .await
    .map_err(|_| "LMS_COOKIE_DELETE_FAILED".to_owned())?
}

fn lms_auth_cookies_from_window(window: &WebviewWindow) -> Result<Vec<Cookie<'static>>, String> {
    let targets = [LMS_ORIGIN, "https://jungle-lms.krafton.com/api/v2/me"];
    let mut seen = HashSet::new();
    let mut auth_cookies = Vec::new();
    for target in targets {
        let url = Url::parse(target).map_err(|_| "LMS_COOKIE_DELETE_FAILED".to_owned())?;
        for cookie in window
            .cookies_for_url(url)
            .map_err(|_| "LMS_COOKIE_DELETE_FAILED".to_owned())?
        {
            if !matches!(cookie.name(), "access_token" | "refresh_token") {
                continue;
            }
            let domain = cookie.domain().unwrap_or(LMS_HOST).trim_start_matches('.');
            if !domain.eq_ignore_ascii_case(LMS_HOST) {
                continue;
            }
            let key = format!(
                "{}\0{}\0{}",
                cookie.name(),
                domain,
                cookie.path().unwrap_or("/")
            );
            if seen.insert(key) {
                auth_cookies.push(cookie);
            }
        }
    }
    Ok(auth_cookies)
}

fn current_epoch_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| {
            i64::try_from(duration.as_millis()).unwrap_or(i64::MAX)
        })
}

#[cfg(test)]
mod tests {
    use super::{
        app_cookie_matches_contract, collect_lms_cookies, current_app_cookie_header,
        heartbeat_state_for_server, installed_cookie_domain_matches,
        is_allowed_login_report_window, is_allowed_main_window, is_exact_remote_origin,
        mark_snapshot_retry_if_allowed, native_notification_disposition, normalize_origin,
        select_origin_value, validate_onboarding_response, validate_origin_pair,
        DesktopSessionState, DisplayedNotificationCache, LmsIdentityUpload, MainDocument,
        MainPrivacySurface, NativeNotificationDisposition, LMS_COLLECTOR_SCRIPT,
        TRIGGER_LMS_COLLECTION_SCRIPT,
    };
    use reqwest::{
        header::{HeaderMap, HeaderValue, CACHE_CONTROL, SET_COOKIE},
        StatusCode,
    };
    use std::sync::atomic::Ordering;
    use tauri::{
        webview::{Cookie, PageLoadEvent},
        Url,
    };

    use crate::{
        agent_protocol::{LmsSessionState, NotificationKind},
        installation::subject_binding_digest,
    };

    fn auth_cookie(name: &'static str, value: &'static str) -> Cookie<'static> {
        Cookie::build((name, value))
            .domain("jungle-lms.krafton.com")
            .path("/")
            .secure(true)
            .http_only(true)
            .build()
    }

    fn stored_app_cookie(value: &'static str) -> Cookie<'static> {
        Cookie::build(("__Secure-jb_app", value))
            .domain("bell.example.com")
            .path("/")
            .http_only(true)
            .secure(true)
            .same_site(tauri::webview::cookie::SameSite::Strict)
            .build()
    }

    fn response_headers(cache_control: &str, cookies: &[&str]) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(CACHE_CONTROL, cache_control.parse().expect("cache control"));
        for cookie in cookies {
            headers.append(SET_COOKIE, cookie.parse().expect("set-cookie"));
        }
        headers
    }

    #[test]
    fn collector_uses_only_local_lms_apis_and_normalized_ipc() {
        for required in [
            r#"window.location.origin !== LMS_ORIGIN"#,
            r#"fetchLms("/api/v2/me","#,
            r#""/api/v2/me/cohorts""#,
            r#"/attendance/today"#,
            r#""report_lms_agent_event""#,
            r#""session-connected""#,
            r#"const LMS_FETCH_TIMEOUT_MS = 12_000"#,
            r#"const controller = new AbortController()"#,
            r#"signal: controller.signal"#,
            r#"inFlight = false"#,
            r#"event.isTrusted"#,
            r#"window.location.pathname.replace(/\/+$/u, "") !== "/check-in""#,
            r#"candidates.length !== 1"#,
            r#"ATTENDANCE_CONFIRMATION_DELAYS_MS"#,
        ] {
            assert!(LMS_COLLECTOR_SCRIPT.contains(required), "{required}");
        }
        for forbidden in [
            "document.cookie",
            "localStorage",
            "access_token",
            "refresh_token",
        ] {
            assert!(!LMS_COLLECTOR_SCRIPT.contains(forbidden), "{forbidden}");
        }
        assert!(TRIGGER_LMS_COLLECTION_SCRIPT.contains("agent.collect"));
    }

    #[test]
    fn wkwebview_startup_never_queries_the_uncommitted_webview_url() {
        let source = include_str!("desktop_session.rs");
        let getter = [".", "url", "(", ")"].concat();
        let payload_getter = ["payload", getter.as_str()].concat();
        assert_eq!(
            source.matches(&getter).count(),
            1,
            "only the page-load payload URL is safe; the WebView URL getter can panic in Wry before commit"
        );
        assert!(source.contains(&payload_getter));
    }

    #[test]
    fn restart_heartbeat_reports_unknown_until_subject_reverification() {
        let directory = tempfile::tempdir().expect("temporary app data");
        let installation_id = "550e8400-e29b-41d4-a716-446655440000".to_owned();
        let binding =
            subject_binding_digest(&installation_id, "lms-user-42").expect("subject binding");
        let state = DesktopSessionState::configured().expect("configured desktop state");
        state
            .initialize_installation(
                installation_id,
                directory.path().to_path_buf(),
                Some(binding),
            )
            .expect("initialized installation");
        state.set_session_state(LmsSessionState::Connected);

        assert!(
            state
                .heartbeat_request()
                .expect("heartbeat guard")
                .is_none(),
            "a subject binding without an app cookie cannot authenticate"
        );
        let mut app_cookie = HeaderValue::from_static("__Secure-jb_app=restart-session");
        app_cookie.set_sensitive(true);
        state
            .replace_app_session(Some(app_cookie))
            .expect("restored app cookie");

        let (_, tentative_state) = state
            .heartbeat_request()
            .expect("heartbeat guard")
            .expect("a bound restart must report its tentative state");
        assert_eq!(
            tentative_state,
            LmsSessionState::Unknown,
            "a connected state is only tentative until the bound subject is reverified"
        );
        assert!(!state.verified_session_features_allowed());
        assert_eq!(
            state.request_main_reveal(),
            MainPrivacySurface::PrivacyGate,
            "a restored server cookie never unlocks the prior user's remote dashboard"
        );
        assert!(
            state
                .notification_request()
                .expect("notification guard")
                .is_some(),
            "an authenticated restart must still receive login-required and queued notifications"
        );

        state.set_session_state(LmsSessionState::LoginRequired);
        let (_, login_required_state) = state
            .heartbeat_request()
            .expect("heartbeat guard")
            .expect("explicit login-required heartbeat");
        assert_eq!(login_required_state, LmsSessionState::LoginRequired);

        state.set_session_state(LmsSessionState::Connected);
        assert_eq!(
            state.mark_subject_verified(),
            MainPrivacySurface::RemoteApp,
            "the pending main-window reveal is released only by current LMS subject verification"
        );
        let (_, verified_state) = state
            .heartbeat_request()
            .expect("heartbeat guard")
            .expect("verified heartbeat");
        assert_eq!(verified_state, LmsSessionState::Connected);
        assert!(state.verified_session_features_allowed());
    }

    #[test]
    fn privacy_gate_state_machine_fails_closed_across_restart_hide_and_reauthentication() {
        let state = DesktopSessionState::configured().expect("configured desktop state");

        assert_eq!(state.request_main_reveal(), MainPrivacySurface::PrivacyGate);
        assert!(!state.verified_session_features_allowed());
        assert_eq!(state.mark_subject_verified(), MainPrivacySurface::RemoteApp);
        assert!(state.verified_session_features_allowed());

        state.request_main_hide();
        assert_eq!(
            state.lock_for_subject_reverification(),
            MainPrivacySurface::Hidden,
            "reauthentication must not reopen a window the user intentionally hid"
        );
        assert!(!state.verified_session_features_allowed());
        assert_eq!(state.mark_subject_verified(), MainPrivacySurface::Hidden);

        assert_eq!(state.request_main_reveal(), MainPrivacySurface::RemoteApp);
        assert_eq!(
            state.lock_for_subject_reverification(),
            MainPrivacySurface::PrivacyGate,
            "a visible remote dashboard is replaced by the privacy gate during reauthentication"
        );
    }

    #[test]
    fn page_load_tracking_ignores_stale_documents_and_gates_command_contexts() {
        let state = DesktopSessionState::configured().expect("configured desktop state");
        assert_eq!(state.main_document(), MainDocument::PrivacyGate);
        assert!(!state.main_document_is_ready(MainDocument::PrivacyGate));
        assert!(!state.main_command_context_allowed());

        assert!(state.record_main_page_load(MainDocument::PrivacyGate, PageLoadEvent::Started));
        assert!(state.record_main_page_load(MainDocument::PrivacyGate, PageLoadEvent::Finished));
        assert!(state.main_document_is_ready(MainDocument::PrivacyGate));
        assert!(!state.main_command_context_allowed());

        state.mark_subject_verified();
        state.begin_main_navigation(MainDocument::RemoteApp);
        assert!(!state.main_document_is_ready(MainDocument::RemoteApp));
        assert!(
            !state.record_main_page_load(MainDocument::PrivacyGate, PageLoadEvent::Finished),
            "a stale gate completion cannot replace the intended remote document"
        );
        assert!(state.record_main_page_load(MainDocument::RemoteApp, PageLoadEvent::Started));
        assert!(state.main_command_context_allowed());

        state.lock_for_subject_reverification();
        state.begin_main_navigation(MainDocument::PrivacyGate);
        assert!(!state.main_command_context_allowed());
        assert!(
            !state.record_main_page_load(MainDocument::RemoteApp, PageLoadEvent::Finished),
            "a stale remote completion cannot unlock commands after reauthentication starts"
        );

        state.record_login_page_load(true, PageLoadEvent::Started);
        assert!(state.login_report_context_allowed());
        state.record_login_page_load(false, PageLoadEvent::Started);
        state.record_login_page_load(true, PageLoadEvent::Finished);
        assert!(
            !state.login_report_context_allowed(),
            "a stale LMS finish cannot re-enable reporting after navigation left LMS"
        );
    }

    #[test]
    fn restored_app_cookie_is_not_reused_until_server_and_local_subject_are_reverified() {
        let directory = tempfile::tempdir().expect("temporary app data");
        let installation_id = "550e8400-e29b-41d4-a716-446655440002".to_owned();
        let binding =
            subject_binding_digest(&installation_id, "lms-user-42").expect("subject binding");
        let state = DesktopSessionState::configured().expect("configured desktop state");
        state
            .initialize_installation(
                installation_id,
                directory.path().to_path_buf(),
                Some(binding),
            )
            .expect("initialized installation");
        let mut restored_cookie =
            HeaderValue::from_static("__Secure-jb_app=possibly-stale-session");
        restored_cookie.set_sensitive(true);
        state
            .replace_app_session(Some(restored_cookie))
            .expect("restored app cookie");

        assert!(
            !state
                .can_reuse_existing_app_session("lms-user-42")
                .expect("reuse decision"),
            "cold-start verification must call onboarding even when the local digest matches"
        );
        state.mark_subject_verified();
        assert!(
            state
                .can_reuse_existing_app_session("lms-user-42")
                .expect("reuse decision"),
            "the current process may reuse the freshly server-verified session"
        );
        assert!(
            !state
                .can_reuse_existing_app_session("lms-user-43")
                .expect("reuse decision"),
            "a different LMS subject always requires server onboarding"
        );
    }

    #[test]
    fn unverified_restart_delivers_only_generic_login_required_notifications() {
        let private_kinds = [
            NotificationKind::MealPublished,
            NotificationKind::LaundryFinishing,
            NotificationKind::LaundryCompleted,
            NotificationKind::LaundryAvailable,
            NotificationKind::LaundryAttention,
            NotificationKind::AttendanceActionRequired,
        ];
        for kind in private_kinds {
            assert_eq!(
                native_notification_disposition(false, kind),
                NativeNotificationDisposition::DeferWithoutAcknowledgement,
                "{kind:?} must remain leased and unacknowledged until subject verification"
            );
        }
        assert_eq!(
            native_notification_disposition(false, NotificationKind::LoginRequired),
            NativeNotificationDisposition::DeliverAndAcknowledge
        );
        for kind in private_kinds
            .into_iter()
            .chain([NotificationKind::LoginRequired])
        {
            assert_eq!(
                native_notification_disposition(true, kind),
                NativeNotificationDisposition::DeliverAndAcknowledge
            );
        }
    }

    #[test]
    fn unverified_inbox_poll_does_not_reclaim_deferred_private_deliveries() {
        let directory = tempfile::tempdir().expect("temporary app data");
        let state = DesktopSessionState::configured().expect("configured desktop state");
        state
            .initialize_installation(
                "550e8400-e29b-41d4-a716-446655440003".to_owned(),
                directory.path().to_path_buf(),
                Some("bound-subject".to_owned()),
            )
            .expect("initialized installation");
        let mut restored_cookie = HeaderValue::from_static("__Secure-jb_app=restart-session");
        restored_cookie.set_sensitive(true);
        state
            .replace_app_session(Some(restored_cookie))
            .expect("restored app cookie");

        assert!(state
            .notification_request()
            .expect("initial unverified inbox request")
            .is_some());
        state.complete_notification_poll(false);
        assert!(
            state
                .notification_request()
                .expect("deferred inbox guard")
                .is_none(),
            "periodic polling must not repeatedly reclaim and exhaust deferred deliveries"
        );

        state.set_session_state(LmsSessionState::LoginRequired);
        assert!(
            state
                .notification_request()
                .expect("login-required transition request")
                .is_some(),
            "one new poll is allowed when LMS newly enters login-required"
        );
        state.complete_notification_poll(false);
        state.set_session_state(LmsSessionState::LoginRequired);
        assert!(
            state
                .notification_request()
                .expect("duplicate login-required guard")
                .is_none(),
            "duplicate collector reports must not rearm the lease"
        );

        state.mark_subject_verified();
        assert!(
            state
                .notification_request()
                .expect("verified inbox request")
                .is_some(),
            "normal periodic inbox polling resumes after subject verification"
        );
    }

    #[test]
    fn notification_poll_requires_an_app_session_and_local_subject_binding() {
        let directory = tempfile::tempdir().expect("temporary app data");
        let state = DesktopSessionState::configured().expect("configured desktop state");
        state
            .initialize_installation(
                "550e8400-e29b-41d4-a716-446655440001".to_owned(),
                directory.path().to_path_buf(),
                None,
            )
            .expect("initialized installation");
        let mut app_cookie = HeaderValue::from_static("__Secure-jb_app=restart-session");
        app_cookie.set_sensitive(true);
        state
            .replace_app_session(Some(app_cookie))
            .expect("restored app cookie");
        assert!(
            state
                .notification_request()
                .expect("notification guard")
                .is_none(),
            "an unbound local installation must not consume another identity's inbox"
        );

        *state
            .bound_subject_digest
            .lock()
            .expect("subject binding state") = Some("bound-subject".to_owned());
        assert!(state
            .notification_request()
            .expect("notification guard")
            .is_some());
        state.app_cookie_rejected.store(true, Ordering::Release);
        assert!(state
            .notification_request()
            .expect("notification guard")
            .is_none());
    }

    #[test]
    fn heartbeat_state_requires_a_binding_and_suppresses_tentative_restart_states() {
        assert_eq!(
            heartbeat_state_for_server(false, false, LmsSessionState::Connected),
            None
        );
        assert_eq!(
            heartbeat_state_for_server(false, true, LmsSessionState::Connected),
            Some(LmsSessionState::Unknown)
        );
        assert_eq!(
            heartbeat_state_for_server(false, true, LmsSessionState::Unknown),
            Some(LmsSessionState::Unknown)
        );
        assert_eq!(
            heartbeat_state_for_server(false, true, LmsSessionState::LoginRequired),
            Some(LmsSessionState::LoginRequired)
        );
        assert_eq!(
            heartbeat_state_for_server(true, true, LmsSessionState::Connected),
            Some(LmsSessionState::Connected)
        );
        assert_eq!(
            heartbeat_state_for_server(true, false, LmsSessionState::LoginRequired),
            None
        );
    }

    #[test]
    fn snapshot_upload_retry_is_bounded_until_a_success_resets_it() {
        let retry_used = std::sync::atomic::AtomicBool::new(false);
        assert!(!mark_snapshot_retry_if_allowed(
            &retry_used,
            "LMS_SESSION_REJECTED"
        ));
        assert!(mark_snapshot_retry_if_allowed(
            &retry_used,
            "ATTENDANCE_SNAPSHOT_FAILED"
        ));
        assert!(!mark_snapshot_retry_if_allowed(
            &retry_used,
            "ATTENDANCE_SNAPSHOT_FAILED"
        ));
        retry_used.store(false, Ordering::Release);
        assert!(mark_snapshot_retry_if_allowed(
            &retry_used,
            "ATTENDANCE_SNAPSHOT_FAILED"
        ));
    }

    #[test]
    fn onboarding_body_contains_installation_bound_proof_without_raw_subject() {
        let cookies = vec![super::LmsCookie {
            name: "access_token".into(),
            value: "opaque".into(),
            domain: "jungle-lms.krafton.com".into(),
            path: "/".into(),
            expires: -1.0,
            http_only: true,
            secure: true,
            same_site: "Lax".into(),
        }];
        let value = serde_json::to_value(LmsIdentityUpload {
            desktop_device_id: "550e8400-e29b-41d4-a716-446655440000",
            subject_binding: "32bb7cb9cdb6aaee5104ac2626e27d402f5825e9b3e7283bd33dfcd1bcae3424",
            cookies: &cookies,
        })
        .expect("serializable");
        assert_eq!(
            value["desktopDeviceId"],
            "550e8400-e29b-41d4-a716-446655440000"
        );
        assert_eq!(value["subjectBinding"].as_str().map(str::len), Some(64));
        assert!(value.get("cookies").is_some());
        assert!(!value.to_string().contains("lms-user-42"));
        assert_eq!(value.as_object().expect("object").len(), 3);
    }

    #[test]
    fn accepts_loopback_http_only_for_debug_and_https_for_release() {
        assert_eq!(
            normalize_origin("http://127.0.0.1:8787", false, "API_ORIGIN_INVALID")
                .expect("debug loopback origin")
                .as_str(),
            "http://127.0.0.1:8787/"
        );
        assert_eq!(
            normalize_origin("https://bell.example.com/", true, "APP_ORIGIN_INVALID")
                .expect("release HTTPS origin")
                .as_str(),
            "https://bell.example.com/"
        );
    }

    #[test]
    fn release_origin_selection_ignores_runtime_environment_values() {
        assert_eq!(
            select_origin_value(
                Some("https://attacker.example".to_owned()),
                Some("https://bell.example.com"),
                "http://127.0.0.1:5173",
                true,
            )
            .as_deref(),
            Some("https://bell.example.com")
        );
        assert_eq!(
            select_origin_value(
                Some("https://attacker.example".to_owned()),
                None,
                "http://127.0.0.1:5173",
                true,
            ),
            None
        );
    }

    #[test]
    fn release_requires_one_shared_app_and_api_origin() {
        let app = Url::parse("https://bell.example.com").expect("app origin");
        let same = Url::parse("https://bell.example.com/").expect("same API origin");
        let other = Url::parse("https://api.example.com").expect("other API origin");
        assert!(validate_origin_pair(&app, &same, true).is_ok());
        assert!(validate_origin_pair(&app, &other, true).is_err());
        assert!(validate_origin_pair(&app, &other, false).is_ok());
    }

    #[test]
    fn exact_remote_origin_allows_paths_but_rejects_confusables() {
        let trusted = Url::parse("https://bell.example.com/").expect("trusted");
        assert!(is_exact_remote_origin(
            &Url::parse("https://bell.example.com/settings").expect("candidate"),
            &trusted
        ));
        for url in [
            "http://bell.example.com/",
            "https://bell.example.com:8443/",
            "https://bell.example.com.evil.test/",
            "https://user@bell.example.com/",
        ] {
            assert!(!is_exact_remote_origin(
                &Url::parse(url).expect("candidate"),
                &trusted
            ));
        }
    }

    #[test]
    fn native_commands_require_exact_window_origins() {
        let trusted = Url::parse("https://bell.example.com/").expect("trusted");
        assert!(is_allowed_main_window(
            "main",
            &Url::parse("https://bell.example.com/app").expect("app"),
            &trusted
        ));
        assert!(is_allowed_login_report_window(
            "lms-login",
            &Url::parse("https://jungle-lms.krafton.com/check-in").expect("LMS"),
        ));
        for (label, url) in [
            ("main", "https://jungle-lms.krafton.com/check-in"),
            ("lms-login", "https://jungle-lms.krafton.com.evil.test/"),
            ("lms-login", "https://accounts.google.com/"),
            ("lms-login", "http://jungle-lms.krafton.com/check-in"),
        ] {
            assert!(!is_allowed_login_report_window(
                label,
                &Url::parse(url).expect("candidate")
            ));
        }
    }

    #[test]
    fn exports_only_the_exact_access_cookie_for_one_time_identity_verification() {
        let cookies = vec![
            auth_cookie("refresh_token", "refresh.value"),
            auth_cookie("access_token", "access.value"),
            auth_cookie("analytics", "not-exported"),
            Cookie::build(("access_token", "insecure"))
                .domain("jungle-lms.krafton.com")
                .path("/")
                .secure(false)
                .http_only(true)
                .build(),
        ];
        let exported = collect_lms_cookies(&cookies).expect("one access cookie");
        assert_eq!(exported.len(), 1);
        assert_eq!(exported[0].name, "access_token");
        assert!(
            exported.iter().all(|cookie| cookie.name != "refresh_token"),
            "refresh cookie must remain exclusively in the LMS WebView"
        );
    }

    #[test]
    fn refuses_missing_or_header_unsafe_access_cookies() {
        assert!(collect_lms_cookies(&[auth_cookie("refresh_token", "refresh.value")]).is_err());
        assert!(collect_lms_cookies(&[
            auth_cookie("access_token", "unsafe;value"),
            auth_cookie("refresh_token", "refresh.value"),
        ])
        .is_err());
    }

    #[test]
    fn onboarding_requires_no_content_no_store_and_one_strict_app_cookie() {
        let app_origin = Url::parse("https://bell.example.com").expect("app origin");
        let headers = response_headers(
            "private, no-store",
            &["__Secure-jb_app=opaque; Domain=bell.example.com; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=7776000"],
        );
        let cookie = validate_onboarding_response(StatusCode::NO_CONTENT, &headers, &app_origin)
            .expect("strict app cookie");
        assert!(app_cookie_matches_contract(&cookie, &app_origin));
    }

    #[test]
    fn onboarding_rejects_ambiguous_or_weakened_cookie_responses() {
        let app_origin = Url::parse("https://bell.example.com").expect("app origin");
        for (status, cache_control, cookies) in [
            (
                StatusCode::CREATED,
                "no-store",
                vec!["__Secure-jb_app=x; Domain=bell.example.com; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=7776000"],
            ),
            (
                StatusCode::NO_CONTENT,
                "private",
                vec!["__Secure-jb_app=x; Domain=bell.example.com; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=7776000"],
            ),
            (
                StatusCode::NO_CONTENT,
                "no-store",
                vec![
                    "__Secure-jb_app=x; Domain=bell.example.com; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=7776000",
                    "extra=y; Domain=bell.example.com; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=7776000",
                ],
            ),
        ] {
            let headers = response_headers(cache_control, &cookies);
            assert!(validate_onboarding_response(status, &headers, &app_origin).is_err());
        }
    }

    #[test]
    fn reads_only_one_exact_http_only_app_cookie_into_sensitive_memory() {
        let app_origin = Url::parse("https://bell.example.com").expect("app origin");
        assert!(installed_cookie_domain_matches(
            Some(".bell.example.com"),
            "bell.example.com"
        ));
        let header = current_app_cookie_header(
            &[
                Cookie::build(("analytics", "ignored"))
                    .domain("bell.example.com")
                    .path("/")
                    .build(),
                stored_app_cookie("prior-session"),
            ],
            &app_origin,
        )
        .expect("cookie store")
        .expect("app cookie");
        assert_eq!(
            header.to_str().expect("header"),
            "__Secure-jb_app=prior-session"
        );
        assert!(header.is_sensitive());
    }

    #[test]
    fn displayed_notification_cache_is_bounded_and_deduplicates() {
        let mut cache = DisplayedNotificationCache::default();
        cache.remember("same".into());
        cache.remember("same".into());
        for index in 0..300 {
            cache.remember(format!("delivery_{index}"));
        }
        assert_eq!(cache.ids.len(), 256);
        assert_eq!(cache.order.len(), 256);
        assert!(!cache.contains("same"));
        assert!(cache.contains("delivery_299"));
    }
}
