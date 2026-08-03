use std::time::Duration;

use tauri_plugin_updater::UpdaterExt;

const STARTUP_UPDATE_DELAY: Duration = Duration::from_secs(10);

pub(crate) fn spawn_startup_update_check(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(STARTUP_UPDATE_DELAY).await;
        if let Err(error) = install_available_update(&app).await {
            eprintln!("desktop-updater stage=startup result={error}");
        }
    });
}

async fn install_available_update(app: &tauri::AppHandle) -> Result<(), &'static str> {
    let updater = app.updater().map_err(|_| "initialization-failed")?;
    let Some(update) = updater.check().await.map_err(|_| "check-failed")? else {
        return Ok(());
    };

    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|_| "install-failed")?;
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::STARTUP_UPDATE_DELAY;
    use std::time::Duration;

    #[test]
    fn startup_update_check_is_delayed_but_not_periodic() {
        assert_eq!(STARTUP_UPDATE_DELAY, Duration::from_secs(10));
        let source = include_str!("updater.rs");
        let implementation = source
            .split("#[cfg(test)]")
            .next()
            .expect("updater implementation");
        assert_eq!(implementation.matches("updater.check().await").count(), 1);
        assert!(!implementation.contains("loop {"));
    }
}
