use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use notify_rust::{Notification, NotificationResponse};

use crate::notification_inbox::NotificationInboxService;

const OPEN_ACTION_ID: &str = "open";
// 출석 알림의 다음 고정 발송(15분) 직전에 기존 액션 listener를 정리한다.
const SYSTEM_NOTIFICATION_TIMEOUT_MS: u32 = 14 * 60 * 1_000;
const _: () = assert!(SYSTEM_NOTIFICATION_TIMEOUT_MS < 15 * 60 * 1_000);
const _: () = assert!(SYSTEM_NOTIFICATION_TIMEOUT_MS >= 10 * 60 * 1_000);
const MAX_ACTION_RESPONSE_LISTENERS: usize = 64;
static ACTIVE_ACTION_RESPONSE_LISTENERS: AtomicUsize = AtomicUsize::new(0);

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
    pub fn any_delivered(self) -> bool {
        self.inbox_recorded
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
            match notify_rust::request_auth_blocking() {
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

        match show_system(
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

fn opens_action(response: &NotificationResponse, action: Option<NotificationAction>) -> bool {
    match response {
        NotificationResponse::Default => true,
        NotificationResponse::Action(value) => {
            action.is_some_and(|action| value == OPEN_ACTION_ID || value == action.button_label())
        }
        NotificationResponse::Reply(_) | NotificationResponse::Closed(_) => false,
    }
}

fn response_timeout(action: Option<NotificationAction>) -> notify_rust::Timeout {
    if action.is_some() {
        notify_rust::Timeout::Milliseconds(SYSTEM_NOTIFICATION_TIMEOUT_MS)
    } else {
        notify_rust::Timeout::Default
    }
}

pub fn show_system(
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

    #[cfg(target_os = "macos")]
    {
        notification.sound_name("Ping");
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
            if !opens_action(response, action) {
                return;
            }
            if let Err(error) = inbox.activate(&app, &notification_id) {
                log::warn!("[notification] inbox activation failed: {error}");
            }
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
    use crate::tray::TrayPanelAction;

    #[test]
    fn 기본_클릭과_열기_버튼만_요청된_액션을_실행한다() {
        let action = NotificationAction::Attendance;

        assert!(opens_action(&NotificationResponse::Default, Some(action)));
        assert!(opens_action(
            &NotificationResponse::Action(OPEN_ACTION_ID.into()),
            Some(action)
        ));
        assert!(opens_action(
            &NotificationResponse::Action(action.button_label().into()),
            Some(action)
        ));
        assert!(!opens_action(
            &NotificationResponse::Action("other".into()),
            Some(action)
        ));
        assert!(!opens_action(&NotificationResponse::Reply("답장".into()), Some(action)));
        assert!(!opens_action(
            &NotificationResponse::Closed(notify_rust::CloseReason::Dismissed),
            Some(action)
        ));
        assert!(opens_action(&NotificationResponse::Default, None));
        assert!(!opens_action(
            &NotificationResponse::Action(OPEN_ACTION_ID.into()),
            None
        ));
    }

    #[test]
    fn 정보성_알림은_os_기본_만료를_사용하고_화면_이동_알림만_listener를_제한한다() {
        assert_eq!(response_timeout(None), notify_rust::Timeout::Default);
        assert_eq!(
            response_timeout(Some(NotificationAction::Attendance)),
            notify_rust::Timeout::Milliseconds(SYSTEM_NOTIFICATION_TIMEOUT_MS)
        );
    }

    #[test]
    fn 모든_알림_액션은_tray와_os_버튼_표현을_가진다() {
        let cases = [
            (
                NotificationAction::Attendance,
                TrayPanelAction::OpenAttendance,
                "출석 페이지 열기",
            ),
            (
                NotificationAction::Laundry,
                TrayPanelAction::OpenLaundry,
                "워시타워 열기",
            ),
            (NotificationAction::Meals, TrayPanelAction::OpenMeals, "식단 열기"),
        ];

        for (action, tray, label) in cases {
            assert_eq!(action.tray_action(), tray);
            assert_eq!(action.button_label(), label);
        }
    }

    #[test]
    fn 앱_알림함에_저장된_경우에만_발송한_것으로_판단한다() {
        assert!(DeliveryReport {
            inbox_recorded: true,
            inbox_created_at: Some(1_000),
            system_delivered: false,
        }
        .any_delivered());
        assert!(!DeliveryReport {
            inbox_recorded: false,
            inbox_created_at: None,
            system_delivered: true,
        }
        .any_delivered());
        assert!(!DeliveryReport::default().any_delivered());
    }
}
