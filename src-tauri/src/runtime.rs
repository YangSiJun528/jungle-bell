//! Tauri runtime adapters for scheduler side effects.

use tauri::Emitter;
use tauri_plugin_notification::NotificationExt;

use crate::checker;
use crate::interval_tasks::{JobAction, JobKind};
use crate::state::{DailyPhase, TraySnapshot};
use crate::tray;

pub(crate) fn apply_tick_side_effects(
    app_handle: &tauri::AppHandle,
    phase: DailyPhase,
    tray_update: Option<&TraySnapshot>,
    notification: Option<&(&'static str, String)>,
    phase_changed: bool,
    job_actions: &[JobAction],
) -> Vec<(JobAction, bool)> {
    if let Some(snapshot) = tray_update {
        tray::update_tray(app_handle, snapshot);
    }

    if let Some((title, body)) = notification {
        match app_handle.notification().builder().title(*title).body(body).show() {
            Ok(_) => log::info!("[scheduler] notification sent: phase={:?}", phase),
            Err(e) => log::error!("[scheduler] notification show failed: {e}"),
        }
    }

    if phase_changed {
        let _ = app_handle.emit("phase-changed", &phase);
    }

    job_actions
        .iter()
        .copied()
        .map(|action| {
            log::debug!(
                "[scheduler] job action: kind={} reason={}",
                action.kind().name(),
                action.reason().label(),
            );
            let succeeded = run_job_action(app_handle, action);
            (action, succeeded)
        })
        .collect()
}

pub(crate) fn run_job_action(app_handle: &tauri::AppHandle, action: JobAction) -> bool {
    match action.kind() {
        JobKind::AttendanceStatusCheck => checker::trigger_current_check(app_handle),
        JobKind::CheckerSessionRefresh => checker::refresh_webview(app_handle, action.reason().label()),
    }
}
