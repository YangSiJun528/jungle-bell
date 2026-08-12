//! Jungle Bell 서버와 데스크톱 앱 사이의 보안 경계.
//!
//! LMS credential은 전용 checker WebView의 profile 밖으로 나오지 않는다.
//! 서버에는 로컬에서 정규화한 출석 snapshot과 서버가 발급한 데스크톱
//! installation credential만 전달한다.

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
use tauri::{Manager, WebviewWindow};
use tokio::sync::{Mutex, Notify, RwLock};
use zeroize::Zeroizing;

use crate::{
    attendance::{AttendanceReport, CohortReportStatus},
    attendance_day,
    notification_service::{NotificationAction, NotificationRequest, NotificationService},
    secure_credential::{self, CredentialStore, PlatformCredentialStoreKind},
    state::AppState,
};

const LMS_HOST: &str = "jungle-lms.krafton.com";
const CHECKER_WINDOW_LABEL: &str = "checker";
const DASHBOARD_WINDOW_LABEL: &str = "dashboard";
const INSTALLATIONS_PATH: &str = "/api/desktop/installations";
const ROTATE_INSTALLATION_PATH: &str = "/api/desktop/installations/rotate";
const WEBVIEW_SESSIONS_PATH: &str = "/api/desktop/webview-sessions";
const CURRENT_WEBVIEW_SESSION_PATH: &str = "/api/desktop/webview-sessions/current";
const ATTENDANCE_SNAPSHOT_PATH: &str = "/api/desktop/attendance";
const HEARTBEAT_PATH: &str = "/api/desktop/heartbeat";
const NOTIFICATIONS_PATH: &str = "/api/desktop/notifications";
const MAX_RESPONSE_BYTES: u64 = 512 * 1024;
const MAX_NOTIFICATION_DELIVERIES: usize = 20;
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(45);
const CREDENTIAL_ROTATION_WINDOW_DAYS: i64 = 7;
const DESKTOP_SESSION_SCHEMA: &str = "jungle-bell.desktop-session";
const DESKTOP_SESSION_SCHEMA_VERSION: u32 = 1;

mod client;
mod contract;
mod service;
mod validation;

use client::*;
pub(crate) use contract::*;
pub(crate) use service::*;
use validation::*;

pub(crate) fn sync_checker_report(
    window: WebviewWindow,
    last_loaded_url: String,
    service: Arc<RemoteSyncService>,
    snapshot: Option<AttendanceSnapshot>,
) {
    if !checker_context_is_allowed(window.label(), Some(&last_loaded_url)) {
        log::warn!("[connected-service] checker report rejected outside exact LMS context");
        return;
    }
    tauri::async_runtime::spawn(async move {
        drop(window);
        if service.registration_needed() {
            if let Err(error) = service.ensure_registered().await {
                log::warn!("[connected-service] desktop registration failed: {}", error.code());
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
    batch: RemoteNotificationBatch,
) {
    for delivery in batch.notifications {
        let key = format!("server:{}", delivery.id);
        let Some(report) = service
            .with_current_identity(batch.identity_generation, || {
                notifications.deliver(
                    app,
                    NotificationRequest {
                        key: &key,
                        title: &delivery.title,
                        body: &delivery.body,
                        action: notification_action(delivery.kind),
                        repeat_after_ms: None,
                    },
                )
            })
            .await
        else {
            return;
        };
        let outcome = if report.any_delivered() {
            NotificationAckOutcome::Displayed
        } else {
            NotificationAckOutcome::Failed
        };
        if let Err(error) = service
            .acknowledge(&delivery.id, outcome, batch.identity_generation)
            .await
        {
            log::warn!(
                "[connected-service] notification ack deferred: id={} error={}",
                delivery.id,
                error.code(),
            );
        }
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

            let session_state = {
                let state = state.lock().await;
                lms_session_state(&state)
            };
            if let Err(error) = service.send_heartbeat(session_state).await {
                log::debug!("[connected-service] heartbeat deferred: {}", error.code());
            } else {
                match service.poll_notifications().await {
                    Ok(deliveries) => {
                        deliver_server_notifications(&app, &service, &notifications, deliveries).await;
                    }
                    Err(error) => {
                        log::debug!("[connected-service] notification poll deferred: {}", error.code());
                    }
                }
            }
        }
    });
}

pub(crate) async fn get_connected_service_status(
    window: WebviewWindow,
    service: tauri::State<'_, Arc<RemoteSyncService>>,
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
) -> Result<ConnectedServiceStatus, String> {
    ensure_dashboard_window(&window)?;
    let lms_state = {
        let state = state.lock().await;
        lms_session_state(&state)
    };
    let mut status = service.status().await;
    status.lms_session_state = lms_state;
    Ok(status)
}

pub(crate) async fn bootstrap_desktop_http_session(
    window: WebviewWindow,
    service: tauri::State<'_, Arc<RemoteSyncService>>,
) -> Result<DesktopHttpSession, String> {
    let url = window.url().map_err(|_| "COMMAND_CONTEXT_DENIED".to_owned())?;
    let origin = dashboard_webview_origin(window.label(), &url)?;
    service.bootstrap_http_session(&origin).await
}

pub(crate) async fn reset_desktop_identity(
    window: WebviewWindow,
    service: tauri::State<'_, Arc<RemoteSyncService>>,
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
    confirmed: bool,
) -> Result<ConnectedServiceStatus, String> {
    let url = window.url().map_err(|_| "COMMAND_CONTEXT_DENIED".to_owned())?;
    let origin = dashboard_webview_origin(window.label(), &url)?;
    if !confirmed {
        return Err("IDENTITY_RESET_CONFIRMATION_REQUIRED".into());
    }
    let lms_state = {
        let state = state.lock().await;
        lms_session_state(&state)
    };
    let mut status = service.reset_identity(&origin).await?;
    status.lms_session_state = lms_state;
    Ok(status)
}

pub(crate) fn open_lms_login(window: WebviewWindow, app: tauri::AppHandle) -> Result<(), String> {
    ensure_dashboard_window(&window)?;
    crate::checker::show_lms_window(&app)
}

pub(crate) async fn refresh_platform_sync(
    app: tauri::AppHandle,
    window: WebviewWindow,
    service: tauri::State<'_, Arc<RemoteSyncService>>,
) -> Result<(), String> {
    ensure_dashboard_window(&window)?;
    service
        .ensure_registered()
        .await
        .map_err(|error| error.code().to_owned())?;
    if app.get_webview_window(CHECKER_WINDOW_LABEL).is_none() {
        return Err("CHECKER_UNAVAILABLE".into());
    }
    let baseline = service.snapshot_revision.load(Ordering::Acquire);
    if !crate::checker::trigger_current_check(&app).await {
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
    fn desktop_http_session_bootstrap은_dashboard의_정확한_local_origin만_허용한다() {
        for expected in ["tauri://localhost", "http://tauri.localhost", "http://127.0.0.1:5173"] {
            let url = Url::parse(&format!("{expected}/settings?tab=service#debug")).unwrap();
            assert_eq!(dashboard_webview_origin("dashboard", &url).unwrap(), expected);
        }

        for invalid in [
            ("checker", "tauri://localhost/"),
            ("dashboard", "https://tauri.localhost/"),
            ("dashboard", "http://localhost:5173/"),
            ("dashboard", "http://127.0.0.1:5174/"),
            ("dashboard", "https://evil.example/"),
            ("dashboard", "http://user@tauri.localhost/"),
        ] {
            let url = Url::parse(invalid.1).unwrap();
            assert_eq!(
                dashboard_webview_origin(invalid.0, &url),
                Err("COMMAND_CONTEXT_DENIED".into())
            );
        }
    }

    #[test]
    fn desktop_http_session_response는_엄격한_jbui_token과_미래_iso_expiry만_받는다() {
        let expires_at = (Utc::now() + chrono::Duration::minutes(5)).to_rfc3339();
        let valid = serde_json::json!({
            "accessToken": format!("jbui_{}", "a".repeat(64)),
            "expiresAt": expires_at,
        });
        let response: DesktopHttpSession = serde_json::from_value(valid.clone()).unwrap();
        assert!(response.validate().is_ok());

        for invalid in [
            serde_json::json!({
                "accessToken": format!("jbd_{}", "a".repeat(64)),
                "expiresAt": expires_at,
            }),
            serde_json::json!({
                "accessToken": format!("jbui_{}", "A".repeat(64)),
                "expiresAt": expires_at,
            }),
            serde_json::json!({
                "accessToken": format!("jbui_{}", "a".repeat(64)),
                "expiresAt": "2020-01-01T00:00:00Z",
            }),
            serde_json::json!({
                "accessToken": format!("jbui_{}", "a".repeat(64)),
                "expiresAt": expires_at,
                "legacy": true,
            }),
        ] {
            let decoded = serde_json::from_value::<DesktopHttpSession>(invalid);
            assert!(decoded.is_err() || decoded.unwrap().validate().is_err());
        }
    }

    #[test]
    fn dynamic_notification_route_ids_are_closed_allowlists() {
        for valid in ["pair_123", "device-ABC", "550e8400-e29b-41d4-a716-446655440000"] {
            assert!(is_safe_route_segment(valid), "{valid}");
        }
        for invalid in ["", "../device", "a/b", "한글", "x?token=secret", &"x".repeat(129)] {
            assert!(!is_safe_route_segment(invalid), "{invalid}");
        }
    }

    #[test]
    fn heartbeat_reports_only_desktop_runtime_state() {
        let heartbeat = Heartbeat {
            lms_session_state: LmsSessionState::Connected,
            app_version: "0.5.0",
        };
        assert_eq!(
            serde_json::to_value(heartbeat).unwrap(),
            serde_json::json!({
                "lmsSessionState": "connected",
                "appVersion": "0.5.0"
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
    fn app_bearer_is_exact_and_stored_only_through_the_credential_store_contract() {
        let token = format!("jbd_{}", "a".repeat(64));
        assert!(is_app_bearer(&token));
        for invalid in [
            format!("jbd_{}", "a".repeat(63)),
            format!("jbd_{}", "A".repeat(64)),
            format!("jwt.{}", "a".repeat(64)),
            format!("jbd_{}", "g".repeat(64)),
        ] {
            assert!(!is_app_bearer(&invalid));
        }
        assert!(BearerCredential::from_wire(token.clone(), "2099-01-01T00:00:00Z").is_err());

        let store = MemoryCredentialStore::new(None);
        let credential = BearerCredential {
            token: Zeroizing::new(token.clone()),
            expires_at: Utc::now() + chrono::Duration::days(30),
        };
        persist_credential(&store, &credential).unwrap();
        let stored = store.load().unwrap().unwrap();
        let restored = decode_stored_credential(&stored).unwrap();
        assert_eq!(&*restored.token, &token);
        assert!(decode_stored_credential(&format!(
            r#"{{"schema":"wrong","schemaVersion":1,"accessToken":"{token}","expiresAt":"2099-01-01T00:00:00Z"}}"#
        ))
        .is_err());
        assert!(decode_stored_credential(&format!(
            r#"{{"accessToken":"{token}","expiresAt":"2099-01-01T00:00:00Z"}}"#
        ))
        .is_err());
        assert!(decode_stored_credential(&format!(
            r#"{{"schema":"jungle-bell.desktop-session","schemaVersion":1,"accessToken":"{token}","expiresAt":"2000-01-01T00:00:00Z"}}"#
        ))
        .is_err());

        let status = ConnectedServiceStatus {
            authenticated: true,
            credential_persistent: true,
            identity_reset_required: false,
            lms_session_state: LmsSessionState::Connected,
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
    fn api_contract_uses_only_canonical_api_routes() {
        let api = RemoteApi::new("https://bell.example.com").unwrap();
        for path in [
            "/api/desktop/installations",
            "/api/desktop/installations/rotate",
            "/api/desktop/webview-sessions",
            "/api/desktop/webview-sessions/current",
            "/api/desktop/heartbeat",
            "/api/desktop/attendance",
            "/api/desktop/notifications",
            "/api/desktop/notifications/test",
        ] {
            assert_eq!(api.endpoint(path).unwrap().path(), path);
        }
        assert!(api.endpoint("/api/desktop/attendance/preferences").is_err());
        assert!(api.endpoint("/v1/attendance/snapshot").is_err());
        assert!(api.endpoint("/api/desktop/automatic-attendance").is_err());
        assert!(api.endpoint("/api/desktop/notifications/notification_1/ack").is_ok());
        assert!(api.endpoint("/api/desktop/mobile-sessions/device_1").is_err());
        assert!(api.endpoint("/api/desktop/meal-preferences").is_err());
        assert!(api.endpoint("/api/desktop/laundry-watches").is_err());
        assert!(api.endpoint("/api/pairings").is_err());
        assert!(api.endpoint("/api/desktop/notifications/../ack").is_err());
        assert!(api.endpoint("/api/private/laundry-watches").is_err());
        assert_eq!(ATTENDANCE_SNAPSHOT_PATH, "/api/desktop/attendance");
    }

    #[test]
    fn desktop_credential_rotates_before_absolute_expiry() {
        let now = Utc.with_ymd_and_hms(2026, 8, 3, 0, 0, 0).unwrap();
        let token = format!("jbd_{}", "a".repeat(64));
        let healthy = BearerCredential {
            token: Zeroizing::new(token.clone()),
            expires_at: now + chrono::Duration::days(8),
        };
        let expiring = BearerCredential {
            token: Zeroizing::new(token),
            expires_at: now + chrono::Duration::days(7),
        };
        assert!(!healthy.should_rotate_at(now));
        assert!(expiring.should_rotate_at(now));
    }

    #[test]
    fn connected_service_reports_lms_state_separately_from_server_authentication() {
        let mut state = AppState::new(Config::default());
        assert_eq!(lms_session_state(&state), LmsSessionState::Unknown);
        state.data_loaded = true;
        assert_eq!(lms_session_state(&state), LmsSessionState::Connected);
        state.needs_login = true;
        assert_eq!(lms_session_state(&state), LmsSessionState::LoginRequired);
    }

    #[tokio::test]
    async fn existing_identity_without_a_valid_app_session_requires_explicit_reset() {
        let directory = tempfile::tempdir().unwrap();
        let service = RemoteSyncService::with_store(
            RemoteApi::new("https://bell.example.com").unwrap(),
            directory.path().to_path_buf(),
            uuid::Uuid::new_v4().hyphenated().to_string(),
            false,
            Arc::new(MemoryCredentialStore::new(None)),
        )
        .unwrap();
        let status = service.status().await;
        assert!(!status.authenticated);
        assert!(status.identity_reset_required);
        assert_eq!(
            service.ensure_registered().await,
            Err(ServiceError::IdentityResetRequired)
        );
    }

    #[tokio::test]
    async fn identity_reset은_webview_revoke가_offline이어도_local_identity를_지운다() {
        let directory = tempfile::tempdir().unwrap();
        let identity = secure_credential::load_or_create_installation_identity(directory.path()).unwrap();
        let original_id = identity.id.clone();
        let credential = BearerCredential {
            token: Zeroizing::new(format!("jbd_{}", "a".repeat(64))),
            expires_at: Utc::now() + chrono::Duration::days(30),
        };
        let store = Arc::new(MemoryCredentialStore::new(None));
        persist_credential(store.as_ref(), &credential).unwrap();
        let service = RemoteSyncService::with_store(
            RemoteApi::new("http://127.0.0.1:9").unwrap(),
            directory.path().to_path_buf(),
            original_id.clone(),
            false,
            store.clone(),
        )
        .unwrap();

        let status = service.reset_identity("tauri://localhost").await.unwrap();
        assert!(!status.authenticated);
        assert_eq!(status.last_error.as_deref(), Some(ServiceError::Unavailable.code()));
        assert_ne!(service.installation_id_for_analytics().await, original_id);
        assert!(service.current_bearer().await.is_none());
        assert!(store.load().unwrap().is_none());
    }

    #[test]
    fn installation_registration_contains_no_lms_identity_or_cookie() {
        let request = DesktopInstallationRequest {
            installation_id: "550e8400-e29b-41d4-a716-446655440000".into(),
        };
        let encoded = serde_json::to_string(&request).unwrap();
        assert_eq!(encoded, r#"{"installationId":"550e8400-e29b-41d4-a716-446655440000"}"#);
        for forbidden in ["cookie", "access_token", "refresh_token", "lms", "subject"] {
            assert!(!encoded.to_ascii_lowercase().contains(forbidden));
        }
    }
}
