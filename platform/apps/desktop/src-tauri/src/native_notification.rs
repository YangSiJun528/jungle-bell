use std::sync::atomic::{AtomicU8, Ordering};

use tauri::{Manager, WebviewWindow};

use crate::desktop_session::{ensure_allowed_main_window, DesktopSessionState};

const TEST_NOTIFICATION_TITLE: &str = "Jungle Bell 테스트";
const TEST_NOTIFICATION_BODY: &str = "데스크톱 알림 연결이 정상입니다.";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub(crate) enum NativeNotificationAuthorization {
    Pending = 0,
    Authorized = 1,
    Denied = 2,
    Failed = 3,
}

#[derive(Debug)]
pub(crate) struct NativeNotificationState {
    authorization: AtomicU8,
}

impl Default for NativeNotificationState {
    fn default() -> Self {
        Self {
            authorization: AtomicU8::new(NativeNotificationAuthorization::Pending as u8),
        }
    }
}

impl NativeNotificationState {
    pub(crate) fn record(&self, authorization: NativeNotificationAuthorization) {
        self.authorization
            .store(authorization as u8, Ordering::Release);
    }

    pub(crate) fn status(&self) -> NativeNotificationAuthorization {
        match self.authorization.load(Ordering::Acquire) {
            value if value == NativeNotificationAuthorization::Authorized as u8 => {
                NativeNotificationAuthorization::Authorized
            }
            value if value == NativeNotificationAuthorization::Denied as u8 => {
                NativeNotificationAuthorization::Denied
            }
            value if value == NativeNotificationAuthorization::Failed as u8 => {
                NativeNotificationAuthorization::Failed
            }
            _ => NativeNotificationAuthorization::Pending,
        }
    }

    pub(crate) fn ensure_authorized(&self) -> Result<(), String> {
        match self.status() {
            NativeNotificationAuthorization::Authorized => Ok(()),
            NativeNotificationAuthorization::Pending => {
                Err("NATIVE_NOTIFICATION_AUTHORIZATION_PENDING".to_owned())
            }
            NativeNotificationAuthorization::Denied => {
                Err("NATIVE_NOTIFICATION_PERMISSION_DENIED".to_owned())
            }
            NativeNotificationAuthorization::Failed => {
                Err("NATIVE_NOTIFICATION_AUTHORIZATION_FAILED".to_owned())
            }
        }
    }
}

pub(crate) fn initialize_native_notifications(app: &tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let authorization = match notify_rust::request_auth().await {
                Ok(true) => {
                    eprintln!("native-notification authorization=authorized");
                    NativeNotificationAuthorization::Authorized
                }
                Ok(false) => {
                    eprintln!("native-notification authorization=denied");
                    NativeNotificationAuthorization::Denied
                }
                Err(error) => {
                    eprintln!("native-notification authorization=failed error={error}");
                    NativeNotificationAuthorization::Failed
                }
            };
            app.state::<NativeNotificationState>().record(authorization);
        });
    }

    #[cfg(not(target_os = "macos"))]
    app.state::<NativeNotificationState>()
        .record(NativeNotificationAuthorization::Authorized);
}

#[tauri::command]
pub(crate) async fn send_native_test_notification(
    window: WebviewWindow,
    state: tauri::State<'_, DesktopSessionState>,
) -> Result<(), String> {
    ensure_allowed_main_window(&window, &state)?;
    show_native_notification(
        window.app_handle(),
        TEST_NOTIFICATION_TITLE,
        TEST_NOTIFICATION_BODY,
    )
    .await
}

pub(crate) async fn show_native_notification(
    app: &tauri::AppHandle,
    title: &str,
    body: &str,
) -> Result<(), String> {
    app.state::<NativeNotificationState>().ensure_authorized()?;
    #[cfg(windows)]
    let identifier = app.config().identifier.clone();
    let title = title.to_owned();
    let body = body.to_owned();

    tauri::async_runtime::spawn_blocking(move || {
        let mut notification = notify_rust::Notification::new();
        notification.summary(&title).body(&body).auto_icon();

        #[cfg(windows)]
        if let Ok(executable) = std::env::current_exe() {
            use std::path::MAIN_SEPARATOR;

            let directory = executable
                .parent()
                .map(|path| path.display().to_string())
                .unwrap_or_default();
            let debug_suffix = format!("{MAIN_SEPARATOR}target{MAIN_SEPARATOR}debug");
            let release_suffix = format!("{MAIN_SEPARATOR}target{MAIN_SEPARATOR}release");
            if !directory.ends_with(&debug_suffix) && !directory.ends_with(&release_suffix) {
                notification.app_id(&identifier);
            }
        }

        notification
            .show()
            .map(|_| ())
            .map_err(|_| "NATIVE_NOTIFICATION_FAILED".to_owned())
    })
    .await
    .map_err(|_| "NATIVE_NOTIFICATION_FAILED".to_owned())?
}

#[cfg(test)]
mod tests {
    use super::{NativeNotificationAuthorization, NativeNotificationState};

    #[test]
    fn notification_authorization_state_is_fail_closed_and_observable() {
        let state = NativeNotificationState::default();
        assert_eq!(
            state.ensure_authorized(),
            Err("NATIVE_NOTIFICATION_AUTHORIZATION_PENDING".to_owned())
        );

        state.record(NativeNotificationAuthorization::Denied);
        assert_eq!(state.status(), NativeNotificationAuthorization::Denied);
        assert_eq!(
            state.ensure_authorized(),
            Err("NATIVE_NOTIFICATION_PERMISSION_DENIED".to_owned())
        );

        state.record(NativeNotificationAuthorization::Failed);
        assert_eq!(
            state.ensure_authorized(),
            Err("NATIVE_NOTIFICATION_AUTHORIZATION_FAILED".to_owned())
        );

        state.record(NativeNotificationAuthorization::Authorized);
        assert_eq!(state.status(), NativeNotificationAuthorization::Authorized);
        assert_eq!(state.ensure_authorized(), Ok(()));
    }
}
