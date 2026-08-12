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
    secure_credential::{self, CredentialStore, KeyringCredentialStore},
    state::AppState,
};

const LMS_HOST: &str = "jungle-lms.krafton.com";
const CHECKER_WINDOW_LABEL: &str = "checker";
const DASHBOARD_WINDOW_LABEL: &str = "dashboard";
const INSTALLATIONS_PATH: &str = "/api/desktop/installations";
const ROTATE_INSTALLATION_PATH: &str = "/api/desktop/installations/rotate";
const ATTENDANCE_SNAPSHOT_PATH: &str = "/api/desktop/attendance";
const ATTENDANCE_PREFERENCES_PATH: &str = "/api/desktop/v2/attendance/preferences";
const HEARTBEAT_PATH: &str = "/api/desktop/heartbeat";
const NOTIFICATIONS_PATH: &str = "/api/desktop/notifications";
const MOBILE_SESSIONS_PATH: &str = "/api/desktop/mobile-sessions";
const MEAL_PREFERENCES_PATH: &str = "/api/desktop/meal-preferences";
const LAUNDRY_WATCHES_PATH: &str = "/api/desktop/laundry-watches";
const LAUNDRY_QUEUE_PATH: &str = "/api/desktop/laundry-queue";
const PAIRINGS_PATH: &str = "/api/pairings";
const MAX_RESPONSE_BYTES: u64 = 512 * 1024;
const MAX_NOTIFICATION_DELIVERIES: usize = 20;
const MAX_LAUNDRY_WATCHES: usize = 64;
const MAX_LAUNDRY_QUEUE_ENTRIES: usize = 256;
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

pub(crate) async fn reset_desktop_identity(
    window: WebviewWindow,
    service: tauri::State<'_, Arc<RemoteSyncService>>,
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
    confirmed: bool,
) -> Result<ConnectedServiceStatus, String> {
    ensure_dashboard_window(&window)?;
    if !confirmed {
        return Err("IDENTITY_RESET_CONFIRMATION_REQUIRED".into());
    }
    let lms_state = {
        let state = state.lock().await;
        lms_session_state(&state)
    };
    let mut status = service.reset_identity().await?;
    status.lms_session_state = lms_state;
    Ok(status)
}

pub(crate) fn open_lms_login(window: WebviewWindow, app: tauri::AppHandle) -> Result<(), String> {
    ensure_dashboard_window(&window)?;
    crate::checker::show_lms_window(&app)
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

pub(crate) async fn get_attendance_preferences(
    window: WebviewWindow,
    service: tauri::State<'_, Arc<RemoteSyncService>>,
) -> Result<AttendancePreferences, String> {
    ensure_dashboard_window(&window)?;
    service.attendance_preferences().await
}

pub(crate) async fn update_attendance_preferences(
    window: WebviewWindow,
    service: tauri::State<'_, Arc<RemoteSyncService>>,
    input: AttendancePreferences,
) -> Result<AttendancePreferences, String> {
    ensure_dashboard_window(&window)?;
    validate_attendance_preferences(&input).map_err(|error| error.code().to_owned())?;
    service.update_attendance_preferences(&input).await
}

pub(crate) async fn get_meal_preferences(
    window: WebviewWindow,
    service: tauri::State<'_, Arc<RemoteSyncService>>,
) -> Result<MealPreferences, String> {
    ensure_dashboard_window(&window)?;
    service.meal_preferences().await
}

pub(crate) async fn update_meal_preferences(
    window: WebviewWindow,
    service: tauri::State<'_, Arc<RemoteSyncService>>,
    input: MealPreferencesInput,
) -> Result<MealPreferences, String> {
    ensure_dashboard_window(&window)?;
    service.update_meal_preferences(&input).await
}

pub(crate) async fn list_laundry_watches(
    window: WebviewWindow,
    service: tauri::State<'_, Arc<RemoteSyncService>>,
) -> Result<LaundryWatchEnvelope, String> {
    ensure_dashboard_window(&window)?;
    service.laundry_watches().await
}

pub(crate) async fn create_laundry_watch(
    window: WebviewWindow,
    service: tauri::State<'_, Arc<RemoteSyncService>>,
    input: LaundryWatchInput,
) -> Result<RemoteLaundryWatch, String> {
    ensure_dashboard_window(&window)?;
    service.create_laundry_watch(&input).await
}

pub(crate) async fn delete_laundry_watch(
    window: WebviewWindow,
    service: tauri::State<'_, Arc<RemoteSyncService>>,
    watch_id: String,
) -> Result<(), String> {
    ensure_dashboard_window(&window)?;
    service.delete_laundry_watch(&watch_id).await
}

pub(crate) async fn list_laundry_queue(
    window: WebviewWindow,
    service: tauri::State<'_, Arc<RemoteSyncService>>,
) -> Result<LaundryQueueEnvelope, String> {
    ensure_dashboard_window(&window)?;
    service.laundry_queue().await
}

pub(crate) async fn join_laundry_queue(
    window: WebviewWindow,
    service: tauri::State<'_, Arc<RemoteSyncService>>,
    input: LaundryQueueInput,
) -> Result<LaundryQueueEntry, String> {
    ensure_dashboard_window(&window)?;
    service.join_laundry_queue(&input).await
}

pub(crate) async fn leave_laundry_queue(
    window: WebviewWindow,
    service: tauri::State<'_, Arc<RemoteSyncService>>,
    entry_id: String,
) -> Result<(), String> {
    ensure_dashboard_window(&window)?;
    service.leave_laundry_queue(&entry_id).await
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
            installation_id: "550e8400-e29b-41d4-a716-446655440000".into(),
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
        assert!(serde_json::from_value::<MobilePairing>(serde_json::json!({
            "id": "pairing_legacy",
            "qrPayload": "https://bell.example.com/dashboard.html#pairing=pairing_legacy&challenge=jbpc_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "manualCode": "01AHJKMNPZ",
            "expiresAt": "2099-01-01T00:00:00Z"
        }))
        .is_err());
    }

    #[test]
    fn api_contract_uses_only_canonical_api_routes() {
        let api = RemoteApi::new("https://bell.example.com").unwrap();
        for path in [
            "/api/desktop/installations",
            "/api/desktop/installations/rotate",
            "/api/desktop/heartbeat",
            "/api/desktop/attendance",
            "/api/desktop/v2/attendance/preferences",
            "/api/desktop/notifications",
            "/api/desktop/notifications/test",
            "/api/desktop/mobile-sessions",
            "/api/desktop/meal-preferences",
            "/api/desktop/laundry-watches",
            "/api/desktop/laundry-queue",
            "/api/pairings",
        ] {
            assert_eq!(api.endpoint(path).unwrap().path(), path);
        }
        assert!(api.endpoint("/api/desktop/attendance/preferences").is_err());
        assert!(api.endpoint("/v1/attendance/snapshot").is_err());
        assert!(api.endpoint("/api/desktop/automatic-attendance").is_err());
        assert!(api.endpoint("/api/desktop/notifications/notification_1/ack").is_ok());
        assert!(api.endpoint("/api/desktop/mobile-sessions/device_1").is_ok());
        assert!(api
            .endpoint(&format!("/api/desktop/laundry-watches/jbw_{}", "a".repeat(64)))
            .is_ok());
        assert!(api
            .endpoint(&format!("/api/desktop/laundry-queue/jbq_{}", "b".repeat(64)))
            .is_ok());
        assert!(api.endpoint("/api/pairings/pairing_1/approve").is_ok());
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

    #[test]
    fn shared_control_dtos_are_strict_and_validate_server_invariants() {
        let preferences: MealPreferences = serde_json::from_value(serde_json::json!({
            "enabled": true,
            "breakfast": false,
            "lunch": true,
            "dinner": true,
            "updatedAtEpochMs": 1_786_000_000_000_i64
        }))
        .unwrap();
        assert!(validate_meal_preferences(&preferences).is_ok());
        assert!(serde_json::from_value::<MealPreferences>(serde_json::json!({
            "enabled": true,
            "breakfast": false,
            "lunch": true,
            "dinner": true,
            "updatedAtEpochMs": 0,
            "legacy": true
        }))
        .is_err());

        let watch: RemoteLaundryWatch = serde_json::from_value(serde_json::json!({
            "id": format!("jbw_{}", "a".repeat(64)),
            "machineId": "washer-1",
            "appliance": "washer",
            "sessionId": "session-1",
            "notifyBeforeMinutes": 10,
            "notifyWhenAvailable": true,
            "status": "active",
            "createdAtEpochMs": 1,
            "updatedAtEpochMs": 2
        }))
        .unwrap();
        assert!(validate_laundry_watch(&watch).is_ok());
        let watch_envelope = LaundryWatchEnvelope {
            watches: vec![watch.clone()],
        };
        assert!(validate_laundry_watches(&watch_envelope).is_ok());

        let entry: LaundryQueueEntry = serde_json::from_value(serde_json::json!({
            "id": format!("jbq_{}", "b".repeat(64)),
            "machineId": null,
            "appliance": "dryer",
            "status": "waiting",
            "joinedAtEpochMs": 1,
            "leftAtEpochMs": null,
            "position": 1
        }))
        .unwrap();
        assert!(validate_laundry_queue_entry(&entry).is_ok());
        assert!(validate_laundry_queue(&LaundryQueueEnvelope { entries: vec![entry] }).is_ok());
    }

    #[test]
    fn shared_control_inputs_reject_unbounded_or_noncanonical_values() {
        for machine_id in ["", " washer-1", "washer-1 ", "washer\n1", &"x".repeat(129)] {
            assert!(validate_machine_id(machine_id, false).is_err(), "{machine_id:?}");
        }
        assert!(validate_machine_id("washer-1", false).is_ok());
        assert!(validate_machine_id("", true).is_ok());

        let invalid_watch = LaundryWatchInput {
            machine_id: "washer-1".into(),
            appliance: LaundryAppliance::Washer,
            session_id: Some(" ".into()),
            notify_before_minutes: 181,
            notify_when_available: true,
        };
        assert!(validate_laundry_watch_input(&invalid_watch).is_err());

        let invalid_queue = LaundryQueueInput {
            machine_id: Some("dryer-1 ".into()),
            appliance: LaundryAppliance::Dryer,
        };
        assert!(validate_laundry_queue_input(&invalid_queue).is_err());
        assert!(!is_laundry_resource_id("jbw_ABC", "jbw_"));
        assert!(is_laundry_resource_id(&format!("jbq_{}", "a".repeat(64)), "jbq_"));
    }

    #[test]
    fn attendance_preferences_are_a_strict_standalone_contract() {
        let input = AttendancePreferences {
            enabled: true,
            morning: true,
            evening: false,
            morning_start_hour: 6,
            evening_end_hour: 2,
            morning_interval_minutes: 5,
            evening_interval_minutes: 10,
            skip_sunday: true,
            skip_attendance_date: Some("2026-08-10".into()),
        };
        assert!(validate_attendance_preferences(&input).is_ok());
        assert_eq!(
            serde_json::to_value(&input).unwrap(),
            serde_json::json!({
                "enabled": true,
                "morning": true,
                "evening": false,
                "morningStartHour": 6,
                "eveningEndHour": 2,
                "morningIntervalMinutes": 5,
                "eveningIntervalMinutes": 10,
                "skipSunday": true,
                "skipAttendanceDate": "2026-08-10"
            })
        );
        assert!(serde_json::from_value::<AttendancePreferences>(serde_json::json!({
            "enabled": true,
            "morning": true,
            "evening": true,
            "morningStartHour": 9,
            "eveningEndHour": 4,
            "morningIntervalMinutes": 15,
            "eveningIntervalMinutes": 15,
            "skipSunday": false,
            "skipAttendanceDate": null,
            "legacy": true
        }))
        .is_err());
        assert!(validate_attendance_preferences(&AttendancePreferences {
            morning_start_hour: 3,
            ..input.clone()
        })
        .is_err());
        assert!(validate_attendance_preferences(&AttendancePreferences {
            evening_interval_minutes: 2,
            ..input.clone()
        })
        .is_err());
        assert!(validate_attendance_preferences(&AttendancePreferences {
            skip_attendance_date: Some("10-08-2026".into()),
            ..input
        })
        .is_err());

        let heartbeat = Heartbeat {
            lms_session_state: LmsSessionState::Connected,
            app_version: "0.5.0",
        };
        let encoded = serde_json::to_value(heartbeat).unwrap();
        assert_eq!(
            encoded,
            serde_json::json!({"lmsSessionState": "connected", "appVersion": "0.5.0"})
        );
        assert!(encoded.get("attendanceNotifications").is_none());
    }
}
