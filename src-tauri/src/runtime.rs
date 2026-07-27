//! Tauri runtime adapters for scheduler side effects.

use std::sync::Arc;

use tauri::{Emitter, Manager};

use crate::campus::{CampusDataKind, CampusService};
use crate::checker;
use crate::interval_tasks::JobAction;
use crate::state::{DailyPhase, TraySnapshot};
use crate::tray;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum JobOutcome {
    Executed,
    NotEligible,
    Retry,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum RuntimeAction {
    AttendanceStatusCheck,
    CheckerSessionRefresh,
    CampusRefresh(CampusDataKind),
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
        RuntimeAction::AttendanceStatusCheck => outcome_from_bool(checker::trigger_current_check(app_handle)),
        RuntimeAction::CheckerSessionRefresh => {
            outcome_from_bool(checker::refresh_webview(app_handle, scheduled.job.reason().label()))
        }
        RuntimeAction::CampusRefresh(kind) => {
            let service: tauri::State<Arc<CampusService>> = app_handle.state();
            match service.refresh_scheduled(app_handle, *kind).await {
                Ok(true) => JobOutcome::Executed,
                Ok(false) => JobOutcome::NotEligible,
                Err(error) => {
                    log::warn!(
                        "[scheduler] campus job failed: id={} error={error}",
                        scheduled.job.kind().name()
                    );
                    service.emit_error(app_handle, *kind, error);
                    JobOutcome::Retry
                }
            }
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
