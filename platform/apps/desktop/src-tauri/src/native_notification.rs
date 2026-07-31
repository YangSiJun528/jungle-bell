use tauri::{Manager, WebviewWindow};

use crate::desktop_session::{ensure_allowed_main_window, DesktopSessionState};

const TEST_NOTIFICATION_TITLE: &str = "Jungle Bell 테스트";
const TEST_NOTIFICATION_BODY: &str = "데스크톱 알림 연결이 정상입니다.";

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
    let identifier = app.config().identifier.clone();
    let title = title.to_owned();
    let body = body.to_owned();

    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "macos")]
        {
            let application = if tauri::is_dev() {
                "com.apple.Terminal"
            } else {
                identifier.as_str()
            };
            let _ = notify_rust::set_application(application);
        }

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
