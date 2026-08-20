//! 서명된 GitHub Release를 확인하고 발견된 업데이트를 설치한다.

use std::sync::Arc;

use semver::Version;
use serde::Serialize;
use tauri::Manager;
use tauri_plugin_updater::UpdaterExt;
use tokio::sync::Mutex;

use crate::notification_service::{NotificationRequest, NotificationService};

static UPDATE_OPERATION: Mutex<()> = Mutex::const_new(());

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopUpdateStatus {
    current_version: String,
    available_version: Option<String>,
    mandatory: bool,
}

impl DesktopUpdateStatus {
    fn new(current_version: impl Into<String>, available_version: Option<String>) -> Self {
        let current_version = current_version.into();
        let mandatory = current_version
            .parse::<Version>()
            .ok()
            .zip(
                available_version
                    .as_deref()
                    .and_then(|version| version.parse::<Version>().ok()),
            )
            .is_some_and(|(current, available)| is_mandatory_update(&current, &available));
        Self {
            current_version,
            available_version,
            mandatory,
        }
    }
}

fn is_mandatory_update(current: &Version, available: &Version) -> bool {
    available.pre.is_empty()
        && available.build.is_empty()
        && (available.major, available.minor) > (current.major, current.minor)
}

pub(crate) async fn check_update(app: &tauri::AppHandle) -> Result<DesktopUpdateStatus, String> {
    let _operation = UPDATE_OPERATION.lock().await;
    let updater = match app.updater() {
        Ok(updater) => updater,
        Err(error) => {
            log::debug!("[updater] updater 초기화 실패: {error}");
            return Err("UPDATER_UNAVAILABLE".into());
        }
    };

    match updater.check().await {
        Ok(Some(update)) => {
            log::info!("[updater] v{} 업데이트 사용 가능", update.version);
            Ok(DesktopUpdateStatus::new(
                app.package_info().version.to_string(),
                Some(update.version),
            ))
        }
        Ok(None) => {
            log::debug!("[updater] 최신 버전");
            Ok(DesktopUpdateStatus::new(app.package_info().version.to_string(), None))
        }
        Err(error) => {
            log::warn!("[updater] 업데이트 확인 실패: {error}");
            Err("UPDATE_CHECK_FAILED".into())
        }
    }
}

pub(crate) async fn install_update(app: tauri::AppHandle) -> Result<(), String> {
    let _operation = UPDATE_OPERATION.lock().await;
    let updater = app.updater().map_err(|error| {
        log::debug!("[updater] updater 초기화 실패: {error}");
        "UPDATER_UNAVAILABLE".to_owned()
    })?;
    let Some(update) = updater.check().await.map_err(|error| {
        log::warn!("[updater] 업데이트 확인 실패: {error}");
        "UPDATE_CHECK_FAILED".to_owned()
    })?
    else {
        log::debug!("[updater] 최신 버전");
        return Ok(());
    };

    let version = update.version.clone();
    log::info!("[updater] v{version} 설치 시작");
    let notifications: tauri::State<Arc<NotificationService>> = app.state();
    let key = format!("updater.installing:{version}");
    let body = format!("v{version}로 업데이트합니다. 잠시 후 재시작됩니다.");
    notifications.deliver(&app, NotificationRequest::system(&key, "Jungle Bell 업데이트", &body));
    update.download_and_install(|_, _| {}, || {}).await.map_err(|error| {
        log::error!("[updater] 업데이트 설치 실패: {error}");
        "UPDATE_INSTALL_FAILED".to_owned()
    })?;
    app.restart()
}

pub(crate) async fn auto_install_update(app: tauri::AppHandle) {
    if let Err(error) = install_update(app).await {
        log::warn!("[updater] 자동 업데이트 중단: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use semver::Version;

    #[test]
    fn 정식_minor_이상_릴리즈만_강제_업데이트한다() {
        let current = Version::parse("0.5.4").unwrap();

        assert!(!is_mandatory_update(&current, &Version::parse("0.5.5").unwrap()));
        assert!(is_mandatory_update(&current, &Version::parse("0.6.0").unwrap()));
        assert!(is_mandatory_update(&current, &Version::parse("1.0.0").unwrap()));
        assert!(!is_mandatory_update(&current, &Version::parse("0.6.0-rc.1").unwrap()));
        assert!(!is_mandatory_update(
            &current,
            &Version::parse("0.6.0+build.1").unwrap()
        ));
    }

    #[test]
    fn 업데이트_상태는_현재_버전과_선택적_최신_버전을_노출한다() {
        let available = DesktopUpdateStatus::new("0.5.0", Some("0.5.1".to_owned()));
        let mandatory = DesktopUpdateStatus::new("0.5.0", Some("0.6.0".to_owned()));
        let current = DesktopUpdateStatus::new("0.6.0", None);

        assert_eq!(
            serde_json::to_value(available).unwrap(),
            serde_json::json!({
                "currentVersion": "0.5.0",
                "availableVersion": "0.5.1",
                "mandatory": false
            })
        );
        assert_eq!(
            serde_json::to_value(mandatory).unwrap(),
            serde_json::json!({
                "currentVersion": "0.5.0",
                "availableVersion": "0.6.0",
                "mandatory": true
            })
        );
        assert_eq!(
            serde_json::to_value(current).unwrap(),
            serde_json::json!({
                "currentVersion": "0.6.0",
                "availableVersion": null,
                "mandatory": false
            })
        );
    }
}
