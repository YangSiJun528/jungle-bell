//! Tauri runtime adapters for scheduler side effects.

use tauri::Emitter;

use crate::checker;
use crate::interval_tasks::JobAction;
use crate::state::{DailyPhase, TraySnapshot};
use crate::tray;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum JobOutcome {
    Executed,
    Retry,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum RuntimeAction {
    CheckerSessionRefresh,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ScheduledAction {
    pub(crate) job: JobAction,
    pub(crate) action: RuntimeAction,
    pub(crate) conflict_key: Option<&'static str>,
    pub(crate) priority: u8,
    pub(crate) coalesced_jobs: Vec<JobAction>,
}

impl ScheduledAction {
    pub(crate) fn new(job: JobAction, action: RuntimeAction, conflict_key: Option<&'static str>, priority: u8) -> Self {
        Self {
            job,
            action,
            conflict_key,
            priority,
            coalesced_jobs: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ScheduledActionResult {
    pub(crate) job: JobAction,
    pub(crate) outcome: JobOutcome,
    pub(crate) coalesced_jobs: Vec<JobAction>,
}

pub(crate) async fn apply_tick_side_effects(
    app_handle: &tauri::AppHandle,
    phase: DailyPhase,
    tray_update: Option<&TraySnapshot>,
    phase_changed: bool,
    job_actions: &[ScheduledAction],
) -> Vec<ScheduledActionResult> {
    if let Some(snapshot) = tray_update {
        if let Err(error) = tray::update_tray(app_handle, snapshot) {
            log::error!("[scheduler] tray projection update failed: {error}");
        }
    }

    if phase_changed {
        let _ = app_handle.emit("phase-changed", &phase);
    }

    let mut results = Vec::with_capacity(job_actions.len());
    for scheduled in job_actions {
        log::debug!(
            "[scheduler] job action: id={} reason={}",
            scheduled.job.kind().name(),
            scheduled.job.reason().label(),
        );
        let outcome = run_action(app_handle, scheduled).await;
        results.push(ScheduledActionResult {
            job: scheduled.job,
            outcome,
            coalesced_jobs: scheduled.coalesced_jobs.clone(),
        });
    }
    results
}

pub(crate) async fn run_action(app_handle: &tauri::AppHandle, scheduled: &ScheduledAction) -> JobOutcome {
    match &scheduled.action {
        RuntimeAction::CheckerSessionRefresh => {
            outcome_from_bool(checker::refresh_webview(app_handle, scheduled.job.reason().label()))
        }
    }
}

fn outcome_from_bool(executed: bool) -> JobOutcome {
    if executed {
        JobOutcome::Executed
    } else {
        JobOutcome::Retry
    }
}
