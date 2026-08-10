//! 서명된 GitHub Release를 확인하고 발견된 업데이트를 설치한다.

use std::sync::Arc;

use tauri::Manager;
use tauri_plugin_updater::UpdaterExt;

use crate::notification_service::{NotificationRequest, NotificationService};

pub(crate) async fn auto_install_update(app: tauri::AppHandle) {
    let updater = match app.updater() {
        Ok(updater) => updater,
        Err(error) => {
            log::debug!("[updater] updater 초기화 실패: {error}");
            return;
        }
    };

    match updater.check().await {
        Ok(Some(update)) => {
            let version = update.version.clone();
            log::info!("[updater] v{version} 설치 시작");
            let notifications: tauri::State<Arc<NotificationService>> = app.state();
            let key = format!("updater.installing:{version}");
            let body = format!("v{version}로 업데이트합니다. 잠시 후 재시작됩니다.");
            notifications.deliver(&app, NotificationRequest::system(&key, "Jungle Bell 업데이트", &body));
            match update.download_and_install(|_, _| {}, || {}).await {
                Ok(()) => app.restart(),
                Err(error) => log::error!("[updater] 업데이트 설치 실패: {error}"),
            }
        }
        Ok(None) => log::debug!("[updater] 최신 버전"),
        Err(error) => log::warn!("[updater] 업데이트 확인 실패: {error}"),
    }
}
