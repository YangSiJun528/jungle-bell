//! Tauri runtime adapters for scheduler side effects.

use std::sync::Arc;

use tauri::{Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

use crate::campus::{CampusDataKind, CampusService};
use crate::checker;
use crate::interval_tasks::{JobAction, JobKind};
use crate::state::{DailyPhase, TraySnapshot};
use crate::tray;

pub(crate) async fn apply_tick_side_effects(
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

    let mut results = Vec::with_capacity(job_actions.len());
    for action in job_actions.iter().copied() {
        log::debug!(
            "[scheduler] job action: kind={} reason={}",
            action.kind().name(),
            action.reason().label(),
        );
        let succeeded = run_job_action(app_handle, action).await;
        results.push((action, succeeded));
    }
    results
}

pub(crate) async fn run_job_action(app_handle: &tauri::AppHandle, action: JobAction) -> bool {
    match action.kind() {
        JobKind::AttendanceStatusCheck => checker::trigger_current_check(app_handle),
        JobKind::CheckerSessionRefresh => checker::refresh_webview(app_handle, action.reason().label()),
        JobKind::LaundryRefresh | JobKind::MealsRefresh => {
            let kind = match action.kind() {
                JobKind::LaundryRefresh => CampusDataKind::Laundry,
                JobKind::MealsRefresh => CampusDataKind::Meals,
                _ => unreachable!(),
            };
            let service: tauri::State<Arc<CampusService>> = app_handle.state();
            match service.refresh_scheduled(app_handle, kind).await {
                Ok(()) => true,
                Err(error) => {
                    log::warn!(
                        "[scheduler] campus job failed: kind={} error={error}",
                        action.kind().name()
                    );
                    service.emit_error(app_handle, kind, error);
                    false
                }
            }
        }
    }
}
