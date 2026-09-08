use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

#[cfg(not(target_os = "macos"))]
use notify_rust::{Notification, NotificationResponse};

use crate::notification_inbox::NotificationInboxService;
use crate::tray::{self, DashboardRoute};

const OPEN_ACTION_ID: &str = "open";
// 반복 알림이 겹쳐도 액션 listener가 장시간 누적되지 않도록 유한 시간 뒤 정리한다.
const SYSTEM_NOTIFICATION_TIMEOUT_MS: u32 = 14 * 60 * 1_000;
const MAX_ACTION_RESPONSE_LISTENERS: usize = 64;
static ACTIVE_ACTION_RESPONSE_LISTENERS: AtomicUsize = AtomicUsize::new(0);

#[derive(Debug, Clone, PartialEq, Eq)]
enum SystemNotificationResponse {
    Default,
    Action(String),
    Reply,
    Closed,
}

impl NotificationAction {
    fn button_label(self) -> &'static str {
        match self {
            Self::Attendance => "출석 페이지 열기",
            Self::Laundry => "워시타워 열기",
            Self::Meals => "식단 열기",
        }
    }
}

pub use crate::notification_inbox::NotificationAction;

pub struct NotificationRequest<'a> {
    pub key: &'a str,
    pub title: &'a str,
    pub body: &'a str,
    pub action: Option<NotificationAction>,
    pub repeat_after_ms: Option<i64>,
}

impl<'a> NotificationRequest<'a> {
    pub fn system(key: &'a str, title: &'a str, body: &'a str) -> Self {
        Self {
            key,
            title,
            body,
            action: None,
            repeat_after_ms: None,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct DeliveryReport {
    pub inbox_recorded: bool,
    pub inbox_created_at: Option<i64>,
    pub system_delivered: bool,
}

impl DeliveryReport {
    pub fn was_displayed(self) -> bool {
        self.system_delivered
    }
}

pub struct NotificationService {
    inbox: Arc<NotificationInboxService>,
}

impl NotificationService {
    pub fn new(inbox: Arc<NotificationInboxService>) -> Self {
        Self { inbox }
    }

    pub fn initialize_system_backend(&self) -> Result<(), String> {
        #[cfg(target_os = "macos")]
        {
            match mac_usernotifications::blocking::request_auth() {
                Ok(true) => Ok(()),
                Ok(false) => Err("macOS 알림 권한이 거부되었습니다.".into()),
                Err(error) => Err(format!("macOS 알림 권한 확인 실패: {error}")),
            }
        }

        #[cfg(not(target_os = "macos"))]
        Ok(())
    }

    pub fn deliver(&self, app: &tauri::AppHandle, request: NotificationRequest<'_>) -> DeliveryReport {
        let mut report = DeliveryReport::default();
        let notification_id = match self.inbox.record(
            app,
            request.key,
            request.title,
            request.body,
            request.action,
            request.repeat_after_ms,
        ) {
            Ok((id, snapshot, inserted)) => {
                report.inbox_recorded = true;
                report.inbox_created_at = snapshot
                    .items
                    .iter()
                    .find(|item| item.id == id)
                    .map(|item| item.created_at);
                if !inserted {
                    return report;
                }
                id
            }
            Err(error) => {
                log::error!(
                    "[notification] inbox persistence failed: key={} error={error}",
                    request.key
                );
                return report;
            }
        };

        match show_system_for_delivery(
            app,
            request.title,
            request.body,
            request.action,
            notification_id,
            self.inbox.clone(),
        ) {
            Ok(()) => {
                report.system_delivered = true;
                log::info!("[notification] OS notification queued: key={}", request.key);
            }
            Err(error) => {
                log::error!(
                    "[notification] OS notification failed: key={} error={error}",
                    request.key
                );
            }
        }

        report
    }
}

struct ActionResponseListenerSlot;

impl ActionResponseListenerSlot {
    fn reserve() -> Option<Self> {
        ACTIVE_ACTION_RESPONSE_LISTENERS
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |active| {
                (active < MAX_ACTION_RESPONSE_LISTENERS).then_some(active + 1)
            })
            .ok()
            .map(|_| Self)
    }
}

impl Drop for ActionResponseListenerSlot {
    fn drop(&mut self) {
        ACTIVE_ACTION_RESPONSE_LISTENERS.fetch_sub(1, Ordering::AcqRel);
    }
}

fn opens_action(response: &SystemNotificationResponse, action: Option<NotificationAction>) -> bool {
    match response {
        SystemNotificationResponse::Default => true,
        SystemNotificationResponse::Action(value) => {
            action.is_some_and(|action| value == OPEN_ACTION_ID || value == action.button_label())
        }
        SystemNotificationResponse::Reply | SystemNotificationResponse::Closed => false,
    }
}

fn response_timeout_duration(action: Option<NotificationAction>) -> Option<Duration> {
    action.map(|_| Duration::from_millis(u64::from(SYSTEM_NOTIFICATION_TIMEOUT_MS)))
}

#[cfg(not(target_os = "macos"))]
fn response_timeout(action: Option<NotificationAction>) -> notify_rust::Timeout {
    match response_timeout_duration(action) {
        Some(_) => notify_rust::Timeout::Milliseconds(SYSTEM_NOTIFICATION_TIMEOUT_MS),
        None => notify_rust::Timeout::Default,
    }
}

#[cfg(target_os = "macos")]
fn normalize_system_response(response: &mac_usernotifications::NotificationResponse) -> SystemNotificationResponse {
    if response.is_default_action() {
        SystemNotificationResponse::Default
    } else if response.is_reply() {
        SystemNotificationResponse::Reply
    } else if response.close_reason.is_some() {
        SystemNotificationResponse::Closed
    } else {
        SystemNotificationResponse::Action(response.action_identifier.clone())
    }
}

#[cfg(not(target_os = "macos"))]
fn normalize_system_response(response: &NotificationResponse) -> SystemNotificationResponse {
    match response {
        NotificationResponse::Default => SystemNotificationResponse::Default,
        NotificationResponse::Action(value) => SystemNotificationResponse::Action(value.clone()),
        NotificationResponse::Reply(_) => SystemNotificationResponse::Reply,
        NotificationResponse::Closed(_) => SystemNotificationResponse::Closed,
    }
}

fn system_notification_dashboard_route(action: Option<NotificationAction>) -> DashboardRoute {
    action.map_or(DashboardRoute::Notifications, NotificationAction::dashboard_route)
}

#[cfg(any(target_os = "macos", test))]
fn should_dispatch_system_notification_to_main_thread(target_is_macos: bool, current_is_main_thread: bool) -> bool {
    target_is_macos && !current_is_main_thread
}

fn show_system_for_delivery(
    app: &tauri::AppHandle,
    title: &str,
    body: &str,
    action: Option<NotificationAction>,
    notification_id: String,
    inbox: Arc<NotificationInboxService>,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use objc2_foundation::MainThreadMarker;

        if should_dispatch_system_notification_to_main_thread(true, MainThreadMarker::new().is_some()) {
            let (sender, receiver) = std::sync::mpsc::sync_channel(1);
            let app_for_task = app.clone();
            let title = title.to_owned();
            let body = body.to_owned();
            app.run_on_main_thread(move || {
                let result = show_system(&app_for_task, &title, &body, action, notification_id, inbox);
                if sender.send(result).is_err() {
                    log::warn!("[notification] main-thread delivery result receiver closed");
                }
            })
            .map_err(|error| format!("운영체제 알림 메인 스레드 예약 실패: {error}"))?;
            return receiver
                .recv_timeout(std::time::Duration::from_secs(10))
                .map_err(|_| "운영체제 알림 메인 스레드 응답 시간 초과".to_owned())?;
        }
    }

    show_system(app, title, body, action, notification_id, inbox)
}

pub fn show_system(
    app: &tauri::AppHandle,
    title: &str,
    body: &str,
    action: Option<NotificationAction>,
    notification_id: String,
    inbox: Arc<NotificationInboxService>,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        show_system_macos(app, title, body, action, notification_id, inbox)
    }

    #[cfg(not(target_os = "macos"))]
    {
        show_system_notify_rust(app, title, body, action, notification_id, inbox)
    }
}

fn handle_system_response(
    app: &tauri::AppHandle,
    inbox: &NotificationInboxService,
    notification_id: &str,
    action: Option<NotificationAction>,
    response: &SystemNotificationResponse,
) {
    if !opens_action(response, action) {
        return;
    }
    if let Err(error) = inbox.mark_read_without_activation(app, notification_id) {
        log::warn!("[notification] inbox read failed: {error}");
    }
    if let Err(error) = tray::open_dashboard_route(app, system_notification_dashboard_route(action)) {
        log::warn!("[notification] system action failed: {error}");
    }
}

#[cfg(target_os = "macos")]
fn show_system_macos(
    app: &tauri::AppHandle,
    title: &str,
    body: &str,
    action: Option<NotificationAction>,
    notification_id: String,
    inbox: Arc<NotificationInboxService>,
) -> Result<(), String> {
    let mut notification = mac_usernotifications::Notification::new()
        .title(title)
        .message(body)
        .sound("Ping");

    if let Some(action) = action {
        notification = notification.action(mac_usernotifications::Action::button(
            OPEN_ACTION_ID,
            action.button_label(),
        ));
        if let Some(timeout) = response_timeout_duration(Some(action)) {
            notification = notification.timeout(timeout);
        }
    }

    let listener_slot = ActionResponseListenerSlot::reserve();
    let handle = notification
        .send_blocking()
        .map_err(|error| format!("운영체제 알림 표시 실패: {error}"))?;

    let Some(listener_slot) = listener_slot else {
        log::warn!("[notification] action response listener limit reached; notification shown without a new listener");
        drop(handle);
        return Ok(());
    };

    let app = app.clone();
    // TODO(notify-rust#277): notify-rust v5에서 async `NotificationHandle::response().await`를
    // 공개하면 이 macOS 전용 어댑터를 제거하고 notify-rust 공통 백엔드로 전환한다.
    tauri::async_runtime::spawn(async move {
        let _listener_slot = listener_slot;
        match handle.response().await {
            Ok(response) => {
                let response = normalize_system_response(&response);
                handle_system_response(&app, &inbox, &notification_id, action, &response);
            }
            Err(error) => log::debug!("[notification] response listener ended: {error}"),
        }
    });

    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn show_system_notify_rust(
    app: &tauri::AppHandle,
    title: &str,
    body: &str,
    action: Option<NotificationAction>,
    notification_id: String,
    inbox: Arc<NotificationInboxService>,
) -> Result<(), String> {
    let mut notification = Notification::new();
    notification
        .appname("Jungle Bell")
        .summary(title)
        .body(body)
        .timeout(response_timeout(action));

    if let Some(action) = action {
        notification.action(OPEN_ACTION_ID, action.button_label());
    }

    #[cfg(windows)]
    configure_windows_identity(app, &mut notification)?;

    let listener_slot = ActionResponseListenerSlot::reserve();
    let handle = notification
        .show()
        .map_err(|error| format!("운영체제 알림 표시 실패: {error}"))?;

    let Some(listener_slot) = listener_slot else {
        log::warn!("[notification] action response listener limit reached; notification shown without a new listener");
        drop(handle);
        return Ok(());
    };

    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _listener_slot = listener_slot;
        if let Err(error) = handle.wait_for_response(move |response: &NotificationResponse| {
            let response = normalize_system_response(response);
            handle_system_response(&app, &inbox, &notification_id, action, &response);
        }) {
            log::debug!("[notification] response listener ended: {error}");
        }
    });

    Ok(())
}

#[cfg(windows)]
fn configure_windows_identity(app: &tauri::AppHandle, notification: &mut Notification) -> Result<(), String> {
    use std::path::MAIN_SEPARATOR;

    let executable =
        tauri::utils::platform::current_exe().map_err(|error| format!("실행 파일 경로 확인 실패: {error}"))?;
    let directory = executable
        .parent()
        .ok_or_else(|| "실행 파일 상위 경로를 확인할 수 없습니다.".to_string())?
        .display()
        .to_string();
    let debug_suffix = format!("{MAIN_SEPARATOR}target{MAIN_SEPARATOR}debug");
    let release_suffix = format!("{MAIN_SEPARATOR}target{MAIN_SEPARATOR}release");
    if !directory.ends_with(&debug_suffix) && !directory.ends_with(&release_suffix) {
        notification.app_id(&app.config().identifier);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn macos_백그라운드_알림은_메인_스레드로_전달한다() {
        assert!(should_dispatch_system_notification_to_main_thread(true, false));
        assert!(!should_dispatch_system_notification_to_main_thread(true, true));
        assert!(!should_dispatch_system_notification_to_main_thread(false, false));
    }

    #[test]
    fn 기본_클릭과_열기_버튼만_요청된_액션을_실행한다() {
        let action = NotificationAction::Attendance;

        assert!(opens_action(&SystemNotificationResponse::Default, Some(action)));
        assert!(opens_action(
            &SystemNotificationResponse::Action(OPEN_ACTION_ID.into()),
            Some(action)
        ));
        assert!(opens_action(
            &SystemNotificationResponse::Action(action.button_label().into()),
            Some(action)
        ));
        assert!(!opens_action(
            &SystemNotificationResponse::Action("other".into()),
            Some(action)
        ));
        assert!(!opens_action(&SystemNotificationResponse::Reply, Some(action)));
        assert!(!opens_action(&SystemNotificationResponse::Closed, Some(action)));
        assert!(opens_action(&SystemNotificationResponse::Default, None));
        assert!(!opens_action(
            &SystemNotificationResponse::Action(OPEN_ACTION_ID.into()),
            None
        ));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_응답을_공통_액션으로_정규화한다() {
        let default = mac_usernotifications::NotificationResponse {
            notification_id: "default".into(),
            action_identifier: "com.apple.UNNotificationDefaultActionIdentifier".into(),
            reply_text: None,
            close_reason: None,
        };
        let action = mac_usernotifications::NotificationResponse {
            notification_id: "action".into(),
            action_identifier: OPEN_ACTION_ID.into(),
            reply_text: None,
            close_reason: None,
        };
        let reply = mac_usernotifications::NotificationResponse {
            notification_id: "reply".into(),
            action_identifier: "reply".into(),
            reply_text: Some("답장".into()),
            close_reason: None,
        };
        let timeout = mac_usernotifications::NotificationResponse {
            notification_id: "timeout".into(),
            action_identifier: String::new(),
            reply_text: None,
            close_reason: Some(mac_usernotifications::CloseReason::Expired),
        };

        assert_eq!(normalize_system_response(&default), SystemNotificationResponse::Default);
        assert_eq!(
            normalize_system_response(&action),
            SystemNotificationResponse::Action(OPEN_ACTION_ID.into())
        );
        assert_eq!(normalize_system_response(&reply), SystemNotificationResponse::Reply);
        assert_eq!(normalize_system_response(&timeout), SystemNotificationResponse::Closed);
    }

    #[test]
    fn 정보성_알림은_만료되지_않고_화면_이동_알림만_14분_뒤_만료한다() {
        assert_eq!(response_timeout_duration(None), None);
        assert_eq!(
            response_timeout_duration(Some(NotificationAction::Attendance)),
            Some(std::time::Duration::from_millis(u64::from(
                SYSTEM_NOTIFICATION_TIMEOUT_MS
            )))
        );
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn notify_rust_timeout_계약을_유지한다() {
        assert_eq!(response_timeout(None), notify_rust::Timeout::Default);
        assert_eq!(
            response_timeout(Some(NotificationAction::Attendance)),
            notify_rust::Timeout::Milliseconds(SYSTEM_NOTIFICATION_TIMEOUT_MS)
        );
    }

    #[test]
    fn 응답_listener는_64개로_제한되고_slot_drop으로_반환된다() {
        assert_eq!(ACTIVE_ACTION_RESPONSE_LISTENERS.load(Ordering::Acquire), 0);

        let slots = (0..MAX_ACTION_RESPONSE_LISTENERS)
            .map(|_| ActionResponseListenerSlot::reserve().expect("listener slot"))
            .collect::<Vec<_>>();
        assert!(ActionResponseListenerSlot::reserve().is_none());

        drop(slots);
        assert_eq!(ACTIVE_ACTION_RESPONSE_LISTENERS.load(Ordering::Acquire), 0);
    }

    #[test]
    fn os_알림_클릭은_도메인_액션을_유지하고_일반_알림은_알림함을_연다() {
        assert_eq!(
            system_notification_dashboard_route(Some(NotificationAction::Laundry)),
            DashboardRoute::Laundry
        );
        assert_eq!(system_notification_dashboard_route(None), DashboardRoute::Notifications);
    }

    #[test]
    fn 모든_알림_액션은_dashboard_route와_os_버튼_표현을_가진다() {
        let cases = [
            (
                NotificationAction::Attendance,
                DashboardRoute::Attendance,
                "출석 페이지 열기",
            ),
            (NotificationAction::Laundry, DashboardRoute::Laundry, "워시타워 열기"),
            (NotificationAction::Meals, DashboardRoute::Meals, "식단 열기"),
        ];

        for (action, route, label) in cases {
            assert_eq!(action.dashboard_route(), route);
            assert_eq!(action.button_label(), label);
        }
    }

    #[test]
    fn 운영체제_알림이_표시된_경우에만_발송한_것으로_판단한다() {
        assert!(!DeliveryReport {
            inbox_recorded: true,
            inbox_created_at: Some(1_000),
            system_delivered: false,
        }
        .was_displayed());
        assert!(DeliveryReport {
            inbox_recorded: false,
            inbox_created_at: None,
            system_delivered: true,
        }
        .was_displayed());
        assert!(!DeliveryReport::default().was_displayed());
    }
}
