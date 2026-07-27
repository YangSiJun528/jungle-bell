//! 스케줄러 모듈 — 앱의 주기적 로직을 구동하는 백그라운드 루프.
//!
//! tokio 태스크로 실행되며 상태용 적응형 틱과 가장 가까운 job deadline 중
//! 먼저 도래하는 시점까지 대기한다. 상태 변경 알림은 이 대기를 즉시 깨운다.
//!
//! 매 틱마다: 날짜 변경 시 일일 리셋, 상태 계산, 트레이 갱신,
//! 체커 WebView 주기적 리로드를 수행.
//! API 기반 조회를 사용하므로 DOM 의존성 없이 안정적으로 동작.

use std::sync::Arc;

use chrono::{DateTime, Datelike, FixedOffset, Timelike, Utc};
use tokio::sync::Mutex;

use tauri::Manager;

use crate::attendance;
use crate::attendance_day;
use crate::campus::CampusDataKind;
use crate::interval_tasks::{self, JobAction, JobEvaluation, JobFailureDecision, JobId, JobSpec};
use crate::local_consumption::LocalConsumptionService;
use crate::runtime::{self, JobOutcome, RuntimeAction, ScheduledAction};
use crate::state::{kst, AppState, DailyPhase, TraySnapshot};

#[cfg(test)]
use crate::state;

/// 액션 필요 시 틱 간격 (초). API 호출 빈도를 줄이기 위해 60초.
const TICK_INTERVAL_ACTIVE: u64 = 60;
/// 대기 시 틱 간격 (초). 5분 간격으로 상태 확인.
const TICK_INTERVAL_IDLE: u64 = 300;

/// 체커 WebView 리로드 간격 (초). 세션/토큰 갱신 목적.
/// 액세스 토큰이 1시간 만료이므로 15분 간격으로 리로드하여 갱신.
const RELOAD_INTERVAL_NORMAL: u64 = 15 * 60; // 15분
const ATTENDANCE_STATUS_CHECK_ID: JobId = JobId::new("attendance_status_check");
const CHECKER_SESSION_REFRESH_ID: JobId = JobId::new("checker_session_refresh");
const LAUNDRY_REFRESH_ID: JobId = JobId::new("laundry_refresh");
const MEALS_REFRESH_ID: JobId = JobId::new("meals_refresh");

const ATTENDANCE_STATUS_CHECK_JOB: JobSpec = JobSpec::on_tick(ATTENDANCE_STATUS_CHECK_ID);
const CHECKER_SESSION_REFRESH_JOB: JobSpec = JobSpec::new(CHECKER_SESSION_REFRESH_ID, RELOAD_INTERVAL_NORMAL)
    .initial_delay_secs(RELOAD_INTERVAL_NORMAL)
    .backoff_secs(30, 5 * 60)
    .max_failures(3);
const LAUNDRY_REFRESH_JOB: JobSpec = JobSpec::new(LAUNDRY_REFRESH_ID, 30)
    .initial_delay_secs(0)
    .backoff_secs(30, 30);
const MEALS_REFRESH_JOB: JobSpec = JobSpec::new(MEALS_REFRESH_ID, 60)
    .initial_delay_secs(0)
    .backoff_secs(60, 60);

#[derive(Debug, Clone)]
struct SchedulerContext {
    now: DateTime<Utc>,
    kst_now: DateTime<FixedOffset>,
    attendance_date: String,
}

#[derive(Clone, Copy)]
struct RegisteredJob {
    id: JobId,
    spec: fn(&AppState) -> JobSpec,
    condition: fn(&AppState, &SchedulerContext) -> bool,
    action: fn(&AppState, &SchedulerContext) -> RuntimeAction,
    conflict_key: Option<&'static str>,
    priority: u8,
}

fn fixed_attendance_status_spec(_state: &AppState) -> JobSpec {
    ATTENDANCE_STATUS_CHECK_JOB
}

fn fixed_checker_refresh_spec(_state: &AppState) -> JobSpec {
    CHECKER_SESSION_REFRESH_JOB
}

fn fixed_laundry_spec(_state: &AppState) -> JobSpec {
    LAUNDRY_REFRESH_JOB
}

fn fixed_meals_spec(_state: &AppState) -> JobSpec {
    MEALS_REFRESH_JOB
}

fn always_eligible(_state: &AppState, _context: &SchedulerContext) -> bool {
    true
}

fn attendance_status_action(_state: &AppState, _context: &SchedulerContext) -> RuntimeAction {
    RuntimeAction::AttendanceStatusCheck
}

fn checker_refresh_action(_state: &AppState, _context: &SchedulerContext) -> RuntimeAction {
    RuntimeAction::CheckerSessionRefresh
}

fn laundry_action(_state: &AppState, _context: &SchedulerContext) -> RuntimeAction {
    RuntimeAction::CampusRefresh(CampusDataKind::Laundry)
}

fn meals_action(_state: &AppState, _context: &SchedulerContext) -> RuntimeAction {
    RuntimeAction::CampusRefresh(CampusDataKind::Meals)
}

const SCHEDULED_JOBS: [RegisteredJob; 4] = [
    RegisteredJob {
        id: ATTENDANCE_STATUS_CHECK_ID,
        spec: fixed_attendance_status_spec,
        condition: always_eligible,
        action: attendance_status_action,
        conflict_key: Some("checker-session"),
        priority: 10,
    },
    RegisteredJob {
        id: CHECKER_SESSION_REFRESH_ID,
        spec: fixed_checker_refresh_spec,
        condition: always_eligible,
        action: checker_refresh_action,
        conflict_key: Some("checker-session"),
        priority: 100,
    },
    RegisteredJob {
        id: LAUNDRY_REFRESH_ID,
        spec: fixed_laundry_spec,
        condition: always_eligible,
        action: laundry_action,
        conflict_key: None,
        priority: 10,
    },
    RegisteredJob {
        id: MEALS_REFRESH_ID,
        spec: fixed_meals_spec,
        condition: always_eligible,
        action: meals_action,
        conflict_key: None,
        priority: 10,
    },
];

/// OS 절전/복귀 등으로 틱이 예상보다 크게 밀렸을 때 checker를 다시 깨운다.
const TICK_DELAY_REFRESH_GRACE_SECS: u64 = 60;
/// 지연된 틱에서는 stale 상태로 알림을 보내지 않고 checker 결과를 짧게 기다린다.
const DELAYED_TICK_RECHECK_INTERVAL_SECS: u64 = 10;

fn registered_job(id: JobId) -> Option<&'static RegisteredJob> {
    SCHEDULED_JOBS.iter().find(|job| job.id == id)
}

fn registered_specs(state: &AppState) -> Vec<JobSpec> {
    SCHEDULED_JOBS.iter().map(|job| (job.spec)(state)).collect()
}

fn record_job_result(state: &mut AppState, action: JobAction, outcome: JobOutcome, now: DateTime<Utc>) {
    let Some(job) = registered_job(action.kind()) else {
        log::warn!("[scheduler] result for unregistered job: id={}", action.kind().name());
        return;
    };
    let kst_now = now.with_timezone(&kst());
    let attendance_date = attendance_day::effective_attendance_date(&state.config, kst_now);
    let evaluation = JobEvaluation::new(now, kst_now, &attendance_date, true);
    let spec = (job.spec)(state);

    match outcome {
        JobOutcome::Executed => {
            state.interval_jobs.mark_success_with_context(&spec, &evaluation);
        }
        JobOutcome::NotEligible => {
            state.interval_jobs.mark_not_eligible_with_context(&spec, &evaluation);
        }
        JobOutcome::Retry => match state.interval_jobs.mark_failure(&spec, now) {
            JobFailureDecision::RetryAt(next_due_at) => log::warn!(
                "[scheduler] job failed: id={} next_retry_at={}",
                action.kind().name(),
                next_due_at.with_timezone(&kst()).format("%Y-%m-%d %H:%M:%S"),
            ),
            JobFailureDecision::GiveUp { kind } => {
                log::error!("[scheduler] job give-up: id={}", kind.name());
            }
        },
    }
}

fn scheduler_context(state: &AppState, now: DateTime<Utc>) -> SchedulerContext {
    let kst_now = now.with_timezone(&kst());
    SchedulerContext {
        now,
        kst_now,
        attendance_date: attendance_day::effective_attendance_date(&state.config, kst_now),
    }
}

fn coalesce_actions(candidates: Vec<ScheduledAction>) -> Vec<ScheduledAction> {
    let mut selected: Vec<ScheduledAction> = Vec::with_capacity(candidates.len());

    for mut candidate in candidates {
        let Some(conflict_key) = candidate.conflict_key else {
            selected.push(candidate);
            continue;
        };
        let Some(index) = selected
            .iter()
            .position(|current| current.conflict_key == Some(conflict_key))
        else {
            selected.push(candidate);
            continue;
        };

        if candidate.priority > selected[index].priority {
            let replaced = std::mem::replace(&mut selected[index], candidate);
            selected[index].coalesced_jobs.push(replaced.job);
            selected[index].coalesced_jobs.extend(replaced.coalesced_jobs);
        } else {
            selected[index].coalesced_jobs.push(candidate.job);
            selected[index].coalesced_jobs.append(&mut candidate.coalesced_jobs);
        }
    }

    selected
}

fn compute_job_actions(state: &mut AppState, context: &SchedulerContext) -> Vec<ScheduledAction> {
    let candidates = SCHEDULED_JOBS
        .iter()
        .filter_map(|job| {
            let spec = (job.spec)(state);
            debug_assert_eq!(spec.kind, job.id);
            let condition_active = (job.condition)(state, context);
            let evaluation =
                JobEvaluation::new(context.now, context.kst_now, &context.attendance_date, condition_active);
            match state.interval_jobs.decide_with_context(&spec, &evaluation) {
                interval_tasks::JobDecision::Run(action) => Some(ScheduledAction::new(
                    action,
                    (job.action)(state, context),
                    job.conflict_key,
                    job.priority,
                )),
                interval_tasks::JobDecision::Skip { .. } | interval_tasks::JobDecision::GiveUp { .. } => None,
            }
        })
        .collect::<Vec<_>>();

    coalesce_actions(candidates)
}

/// 틱 한 번의 순수 계산 결과. 부수효과는 호출자가 수행.
pub(crate) struct TickResult {
    /// 다음 틱까지 대기할 초.
    pub tick_interval: u64,
    /// 이번 틱에 실행할 job 목록.
    pub job_actions: Vec<ScheduledAction>,
    /// phase가 변경되었는지 여부.
    pub phase_changed: bool,
    /// 트레이 갱신 정보. None이면 갱신하지 않음 (data_loaded 전).
    pub tray_update: Option<TraySnapshot>,
    /// 일일 리셋이 수행되었는지 여부.
    pub daily_reset: bool,
}

impl TickResult {
    #[cfg(test)]
    pub(crate) fn has_job_action(&self, kind: JobId) -> bool {
        self.job_actions.iter().any(|action| action.job.kind() == kind)
    }
}

fn is_phase_actionable(phase: DailyPhase) -> bool {
    matches!(
        phase,
        DailyPhase::NeedStart | DailyPhase::StartOverdue | DailyPhase::NeedEnd
    )
}

fn compute_phase_update(state: &mut AppState, now: DateTime<Utc>) -> Option<(DailyPhase, Option<i64>)> {
    attendance::compute_phase_update(state, now).map(|update| (update.phase, update.remaining))
}

fn expire_login_retry_window(state: &mut AppState, now: DateTime<Utc>) {
    if matches!(state.login_retry_until, Some(until) if now >= until) {
        state.login_retry_until = None;
    }
}

#[cfg(test)]
fn tick_delayed(previous_tick: DateTime<Utc>, expected_interval_secs: u64, now: DateTime<Utc>) -> Option<i64> {
    interval_tasks::delayed_tick_action(
        previous_tick,
        expected_interval_secs,
        now,
        TICK_DELAY_REFRESH_GRACE_SECS,
        JobId::new("checker_session_refresh"),
    )
    .map(|_| (now - previous_tick).num_seconds())
}

async fn refresh_checker_after_delayed_tick(
    app_handle: &tauri::AppHandle,
    action: JobAction,
    elapsed_secs: i64,
    expected_interval_secs: u64,
) -> JobOutcome {
    log::info!(
        "[scheduler] delayed tick detected: elapsed={}s expected={}s",
        elapsed_secs,
        expected_interval_secs,
    );

    let scheduled = ScheduledAction::new(
        action,
        RuntimeAction::CheckerSessionRefresh,
        Some("checker-session"),
        100,
    );
    runtime::run_action(app_handle, &scheduled).await
}

fn log_tick_state(now: DateTime<Utc>, state: &AppState, result: &TickResult) {
    if result.daily_reset {
        let kst_now = now.with_timezone(&kst());
        log::info!("[scheduler] daily reset at KST={}", kst_now.format("%Y-%m-%d %H:%M:%S"));
    }

    if result.phase_changed {
        log::info!(
            "[scheduler] phase={:?} started={} ended={} remaining={:?} needs_login={}",
            state.phase,
            state.morning_checked,
            state.evening_checked,
            result.tray_update.as_ref().and_then(|snapshot| snapshot.remaining),
            state.needs_login,
        );
    }

    log::debug!(
        "[scheduler] state: phase={:?} morning_checked={} evening_checked={} \
         needs_login={} data_loaded={} kst={}",
        state.phase,
        state.morning_checked,
        state.evening_checked,
        state.needs_login,
        state.data_loaded,
        now.with_timezone(&kst()).format("%Y-%m-%d %H:%M:%S"),
    );
}

/// 일일 리셋 판단: KST 날짜가 바뀌고 morning_start 이후이면 리셋 수행.
///
/// 리셋이 수행되면 `true` 반환.
pub(crate) fn check_daily_reset(state: &mut AppState, kst_now: DateTime<FixedOffset>) -> bool {
    let current_day = kst_now.ordinal();
    let current_hour = kst_now.hour();

    if let Some(last_day) = state.last_reset_day {
        if current_day != last_day && current_hour >= state.config.morning_start.hour {
            state.morning_checked = false;
            state.evening_checked = false;
            state.last_reset_day = Some(current_day);
            return true;
        }
    } else {
        state.last_reset_day = Some(current_day);
    }
    false
}

#[cfg(test)]
pub(crate) fn should_notify(
    config: &crate::config::Config,
    phase: DailyPhase,
    remaining: Option<i64>,
    needs_login: bool,
    kst_now: DateTime<FixedOffset>,
) -> attendance::NotificationDecision {
    attendance::notification_decision(config, phase, remaining, needs_login, kst_now)
}

/// 적응형 틱 간격 계산 (순수 함수).
pub(crate) fn compute_tick_interval(
    data_loaded: bool,
    needs_login: bool,
    attendance_open: bool,
    login_retry_active: bool,
    phase: DailyPhase,
    remaining: Option<i64>,
) -> u64 {
    let base_interval = if !data_loaded {
        5
    } else if needs_login {
        match (attendance_open, login_retry_active) {
            (true, _) | (_, true) => 10,
            _ => 600,
        }
    } else {
        if is_phase_actionable(phase) {
            TICK_INTERVAL_ACTIVE
        } else {
            TICK_INTERVAL_IDLE
        }
    };

    match remaining.map(|secs| secs as u64) {
        Some(secs) if secs > 0 && secs < base_interval => secs + 1,
        _ => base_interval,
    }
}

fn compute_next_wake_interval(tick_interval: u64, now: DateTime<Utc>, next_job_due_at: Option<DateTime<Utc>>) -> u64 {
    let Some(next_due_at) = next_job_due_at else {
        return tick_interval;
    };
    let remaining_millis = (next_due_at - now).num_milliseconds();
    let job_interval = if remaining_millis <= 0 {
        1
    } else {
        ((remaining_millis as u64).saturating_add(999) / 1000).max(1)
    };
    tick_interval.min(job_interval)
}

#[cfg(test)]
pub(crate) fn notification_message(phase: DailyPhase, remaining: Option<i64>) -> (&'static str, String) {
    attendance::notification_message(phase, remaining)
}

/// 스케줄러 틱 한 번의 순수 계산.
///
/// 상태를 갱신하고, 부수효과 지시를 `TickResult`로 반환.
/// 실제 부수효과(tray 갱신, 알림 발송, WebView 리로드)는 호출자가 수행.
pub(crate) fn compute_tick(state: &mut AppState, now: DateTime<Utc>, attendance_open: bool) -> TickResult {
    let kst_now = now.with_timezone(&kst());

    // --- 일일 리셋 ---
    let daily_reset = check_daily_reset(state, kst_now);

    // --- 상태 계산 ---
    let previous_phase = state.phase;
    let phase_update = compute_phase_update(state, now);
    let remaining = phase_update.map(|(_, remaining)| remaining).unwrap_or(None);
    let phase_changed = phase_update.map(|(phase, _)| phase != previous_phase).unwrap_or(false);
    let tray_update = phase_update.map(|(_, remaining)| state.tray_snapshot(remaining));

    // --- 주기 job ---
    // 공통 데이터 조회와 checker 갱신 작업만 선언형 job 엔진에서 평가한다.
    let context = scheduler_context(state, now);
    let job_actions = compute_job_actions(state, &context);

    // --- 로그인 재시도 윈도우 만료 확인 ---
    expire_login_retry_window(state, now);

    // --- 적응형 틱 간격 ---
    let login_retry_active = state.login_retry_until.is_some();
    let tick_interval = compute_tick_interval(
        state.data_loaded,
        state.needs_login,
        attendance_open,
        login_retry_active,
        state.phase,
        remaining,
    );

    TickResult {
        tick_interval,
        job_actions,
        phase_changed,
        tray_update,
        daily_reset,
    }
}

/// 백그라운드 스케줄러 루프 시작.
pub fn start_scheduler(app_handle: tauri::AppHandle, shared_state: Arc<Mutex<AppState>>) {
    tauri::async_runtime::spawn(async move {
        {
            let s = shared_state.lock().await;
            log::info!(
                "[scheduler] config: day_start={:02}:{:02} start_deadline={:02}:{:02} end_open={:02}:{:02} day_end={:02}:{:02}",
                s.config.morning_start.hour,
                s.config.morning_start.minute,
                s.config.morning_end.hour,
                s.config.morning_end.minute,
                s.config.evening_start.hour,
                s.config.evening_start.minute,
                s.config.evening_end.hour,
                s.config.evening_end.minute,
            );
        }

        let scheduler_wakeup = shared_state.lock().await.scheduler_wakeup.clone();
        let mut previous_tick: Option<DateTime<Utc>> = None;
        let mut previous_interval_secs: Option<u64> = None;

        loop {
            let now = Utc::now();
            let delayed_tick = previous_tick
                .zip(previous_interval_secs)
                .and_then(|(previous_tick, interval)| {
                    let action = interval_tasks::delayed_tick_action(
                        previous_tick,
                        interval,
                        now,
                        TICK_DELAY_REFRESH_GRACE_SECS,
                        CHECKER_SESSION_REFRESH_ID,
                    )?;
                    Some(((now - previous_tick).num_seconds(), interval, action))
                });

            if let Some((elapsed, interval, action)) = delayed_tick {
                let outcome = refresh_checker_after_delayed_tick(&app_handle, action, elapsed, interval).await;
                {
                    let mut state = shared_state.lock().await;
                    record_job_result(&mut state, action, outcome, now);
                }
                previous_tick = Some(now);
                previous_interval_secs = Some(DELAYED_TICK_RECHECK_INTERVAL_SECS);
                tokio::select! {
                    _ = tokio::time::sleep(tokio::time::Duration::from_secs(
                        DELAYED_TICK_RECHECK_INTERVAL_SECS,
                    )) => {}
                    _ = scheduler_wakeup.notified() => {}
                }
                continue;
            }

            let (tick_result, phase) = {
                let mut s = shared_state.lock().await;
                let attendance_open = app_handle.get_webview_window("attendance").is_some();

                let result = compute_tick(&mut s, now, attendance_open);
                let phase = s.phase;

                log_tick_state(now, &s, &result);
                (result, phase)
            };

            let local_consumption: tauri::State<'_, Arc<LocalConsumptionService>> = app_handle.state();
            local_consumption
                .on_scheduler_tick(
                    &app_handle,
                    now,
                    phase,
                    tick_result.tray_update.as_ref().and_then(|snapshot| snapshot.remaining),
                )
                .await;
            let job_results = runtime::apply_tick_side_effects(
                &app_handle,
                phase,
                tick_result.tray_update.as_ref(),
                tick_result.phase_changed,
                &tick_result.job_actions,
            )
            .await;
            {
                let mut s = shared_state.lock().await;
                for result in job_results {
                    record_job_result(&mut s, result.job, result.outcome, now);
                    if result.outcome == JobOutcome::Executed {
                        for coalesced in result.coalesced_jobs {
                            record_job_result(&mut s, coalesced, JobOutcome::Executed, now);
                        }
                    }
                }
            }

            let wake_started_at = Utc::now();
            let next_job_due_at = {
                let state = shared_state.lock().await;
                state.interval_jobs.next_due_at_for(&registered_specs(&state))
            };
            let wake_interval = compute_next_wake_interval(tick_result.tick_interval, wake_started_at, next_job_due_at);
            log::debug!(
                "[scheduler] tick: base_interval={}s wake_interval={}s next_job_due_at={:?}",
                tick_result.tick_interval,
                wake_interval,
                next_job_due_at,
            );

            previous_tick = Some(now);
            previous_interval_secs = Some(wake_interval);

            tokio::select! {
                _ = tokio::time::sleep(tokio::time::Duration::from_secs(wake_interval)) => {}
                _ = scheduler_wakeup.notified() => {
                    log::debug!("[scheduler] state change wake-up");
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use crate::state::DdayStatus;
    use chrono::TimeZone;

    fn kst_dt(h: u32, m: u32, s: u32) -> DateTime<FixedOffset> {
        FixedOffset::east_opt(9 * 3600)
            .unwrap()
            .with_ymd_and_hms(2026, 3, 17, h, m, s)
            .unwrap()
    }

    /// KST 시각을 UTC DateTime으로 변환하는 헬퍼.
    fn kst_utc(h: u32, m: u32, s: u32) -> DateTime<Utc> {
        kst_dt(h, m, s).with_timezone(&Utc)
    }

    fn default_state() -> AppState {
        AppState::new(Config::default())
    }

    // --- check_daily_reset ---

    #[test]
    fn 첫_호출시_날짜가_설정되고_리셋은_발생하지_않는다() {
        // given
        let mut state = default_state();
        assert!(state.last_reset_day.is_none());

        // when
        let reset = check_daily_reset(&mut state, kst_dt(9, 0, 0));

        // then
        assert!(!reset);
        assert!(state.last_reset_day.is_some());
    }

    #[test]
    fn 같은_날에는_리셋이_발생하지_않는다() {
        // given
        let mut state = default_state();
        let kst = kst_dt(9, 0, 0);
        check_daily_reset(&mut state, kst);
        state.morning_checked = true;
        state.evening_checked = true;

        // when
        let reset = check_daily_reset(&mut state, kst);

        // then
        assert!(!reset);
        assert!(state.morning_checked);
    }

    #[test]
    fn 다음날_morning_start_이후에는_리셋이_발생한다() {
        // given
        let mut state = default_state();
        let day1 = kst_dt(9, 0, 0);
        check_daily_reset(&mut state, day1);
        state.morning_checked = true;
        state.evening_checked = true;

        // when: 다음 날 05:00 (morning_start=04:00 이후)
        let day2 = FixedOffset::east_opt(9 * 3600)
            .unwrap()
            .with_ymd_and_hms(2026, 3, 18, 5, 0, 0)
            .unwrap();
        let reset = check_daily_reset(&mut state, day2);

        // then
        assert!(reset);
        assert!(!state.morning_checked);
        assert!(!state.evening_checked);
    }

    #[test]
    fn 다음날_morning_start_이전에는_리셋이_발생하지_않는다() {
        // given
        let mut state = default_state();
        let day1 = kst_dt(9, 0, 0);
        check_daily_reset(&mut state, day1);
        state.morning_checked = true;

        // when: 다음 날 02:00 (morning_start=04:00 이전)
        let day2 = FixedOffset::east_opt(9 * 3600)
            .unwrap()
            .with_ymd_and_hms(2026, 3, 18, 2, 0, 0)
            .unwrap();
        let reset = check_daily_reset(&mut state, day2);

        // then
        assert!(!reset);
        assert!(state.morning_checked);
    }

    // --- should_notify ---

    #[test]
    fn 시작_알림_비활성화시_시작_알림을_보내지_않는다() {
        // given
        let mut config = Config::default();
        config.start_notification_enabled = false;

        // when
        let d = should_notify(&config, DailyPhase::NeedStart, Some(3600), false, kst_dt(9, 30, 0));

        // then
        assert!(!d.send);
    }

    #[test]
    fn 종료_알림_비활성화시_종료_알림을_보내지_않는다() {
        // given
        let mut config = Config::default();
        config.end_notification_enabled = false;

        // when: KST 23:30 — 저녁 윈도우 내
        let d = should_notify(&config, DailyPhase::NeedEnd, Some(3600), false, kst_dt(23, 30, 0));

        // then
        assert!(!d.send);
    }

    #[test]
    fn 시작_알림_비활성화시에도_종료_알림은_발송된다() {
        // given
        let mut config = Config::default();
        config.start_notification_enabled = false;

        // when: KST 23:30 — 저녁 윈도우 내
        let d = should_notify(&config, DailyPhase::NeedEnd, Some(3600), false, kst_dt(23, 30, 0));

        // then
        assert!(d.send);
    }

    #[test]
    fn 로그인_필요시_알림을_보내지_않는다() {
        // given
        let config = Config::default();

        // when
        let d = should_notify(&config, DailyPhase::NeedStart, Some(3600), true, kst_dt(9, 30, 0));

        // then
        assert!(!d.send);
    }

    #[test]
    fn 액션_불필요_페이즈에서는_알림을_보내지_않는다() {
        // given
        let config = Config::default();

        // when
        let d = should_notify(&config, DailyPhase::Studying, Some(3600), false, kst_dt(12, 0, 0));

        // then
        assert!(!d.send);
    }

    #[test]
    fn 알림_윈도우_이전에는_알림을_보내지_않는다() {
        let config = Config::default();

        // when: KST 08:00 — 아침 알림 윈도우 전
        let d = should_notify(&config, DailyPhase::NeedStart, Some(7200), false, kst_dt(8, 0, 0));

        // then
        assert!(!d.send);
    }

    #[test]
    fn 알림_윈도우_내_첫_알림은_발송된다() {
        let config = Config::default();

        // when
        let d = should_notify(&config, DailyPhase::NeedStart, Some(3600), false, kst_dt(9, 30, 0));

        // then
        assert!(d.send);
        assert!(d.message.is_some());
    }

    #[test]
    fn 자정을_넘긴_저녁_윈도우_내에서_알림이_발송된다() {
        let config = Config::default();

        // when: KST 00:30 — 자정 넘긴 저녁 윈도우 내
        let kst_0030 = FixedOffset::east_opt(9 * 3600)
            .unwrap()
            .with_ymd_and_hms(2026, 3, 18, 0, 30, 0)
            .unwrap();
        let d = should_notify(&config, DailyPhase::NeedEnd, Some(12600), false, kst_0030);

        // then
        assert!(d.send);
    }

    #[test]
    fn 저녁_윈도우_종료_후에는_알림을_보내지_않는다() {
        let config = Config::default();

        // when: KST 04:30 — 윈도우 밖
        let kst_0430 = FixedOffset::east_opt(9 * 3600)
            .unwrap()
            .with_ymd_and_hms(2026, 3, 18, 4, 30, 0)
            .unwrap();
        let d = should_notify(&config, DailyPhase::NeedEnd, Some(9000), false, kst_0430);

        // then
        assert!(!d.send);
    }

    // --- compute_tick_interval ---

    #[test]
    fn 데이터_미로드시_틱_간격은_5초이다() {
        // given & when
        let result = compute_tick_interval(false, false, false, false, DailyPhase::Idle, None);

        // then
        assert_eq!(result, 5);
    }

    #[test]
    fn 로그인_필요하고_출석_열려있으면_틱_간격은_10초이다() {
        // given & when
        let result = compute_tick_interval(true, true, true, false, DailyPhase::Idle, None);

        // then
        assert_eq!(result, 10);
    }

    #[test]
    fn 로그인_필요하고_재시도_활성화시_틱_간격은_10초이다() {
        // given & when
        let result = compute_tick_interval(true, true, false, true, DailyPhase::Idle, None);

        // then
        assert_eq!(result, 10);
    }

    #[test]
    fn 로그인_필요하고_재시도_없으면_틱_간격은_600초이다() {
        // given & when
        let result = compute_tick_interval(true, true, false, false, DailyPhase::Idle, None);

        // then
        assert_eq!(result, 600);
    }

    #[test]
    fn 액티브_페이즈에서_틱_간격은_활성_간격이다() {
        // given & when
        let result = compute_tick_interval(true, false, false, false, DailyPhase::NeedStart, Some(3600));

        // then
        assert_eq!(result, TICK_INTERVAL_ACTIVE);
    }

    #[test]
    fn 유휴_페이즈에서_틱_간격은_유휴_간격이다() {
        // given & when
        let result = compute_tick_interval(true, false, false, false, DailyPhase::Studying, Some(1800));

        // then
        assert_eq!(result, TICK_INTERVAL_IDLE);
    }

    #[test]
    fn 잔여시간이_기본_간격보다_짧으면_잔여시간_플러스_1이다() {
        // given & when: remaining=30 < base=60 → 31
        let result = compute_tick_interval(true, false, false, false, DailyPhase::NeedStart, Some(30));

        // then
        assert_eq!(result, 31);
    }

    #[test]
    fn 잔여시간이_0이면_기본_간격을_사용한다() {
        // given & when
        let result = compute_tick_interval(true, false, false, false, DailyPhase::NeedStart, Some(0));

        // then
        assert_eq!(result, TICK_INTERVAL_ACTIVE);
    }

    #[test]
    fn 가까운_job_due는_기본_틱보다_먼저_스케줄러를_깨운다() {
        let now = kst_utc(9, 0, 0);

        assert_eq!(
            compute_next_wake_interval(300, now, Some(now + chrono::Duration::seconds(30))),
            30
        );
    }

    #[test]
    fn 이미_due인_job은_1초_후_재검사한다() {
        let now = kst_utc(9, 0, 0);

        assert_eq!(
            compute_next_wake_interval(300, now, Some(now - chrono::Duration::seconds(1))),
            1
        );
    }

    // --- notification_message ---

    #[test]
    fn 출석체크_필요시_시간_분_메시지를_생성한다() {
        let (title, body) = notification_message(DailyPhase::NeedStart, Some(5400));
        assert_eq!(title, "출석 체크 시간입니다");
        assert_eq!(body, "마감까지 1시간 30분 남았습니다.");
    }

    #[test]
    fn 출석체크_필요시_분만_있으면_시간을_표시하지_않는다() {
        let (title, body) = notification_message(DailyPhase::NeedStart, Some(1800));
        assert_eq!(title, "출석 체크 시간입니다");
        assert_eq!(body, "마감까지 30분 남았습니다.");
    }

    #[test]
    fn 출석체크_필요시_잔여시간_없으면_기본_메시지를_생성한다() {
        let (title, body) = notification_message(DailyPhase::NeedStart, None);
        assert_eq!(title, "출석 체크 시간입니다");
        assert_eq!(body, "출석 체크를 해주세요.");
    }

    #[test]
    fn 지각시_지각_메시지를_생성한다() {
        let (title, body) = notification_message(DailyPhase::StartOverdue, None);
        assert_eq!(title, "출석 체크 지각!");
        assert_eq!(body, "빨리 체크인하세요.");
    }

    #[test]
    fn 지각_임박시_임박_메시지를_생성한다() {
        let (title, body) = notification_message(DailyPhase::StartOverdue, Some(300));
        assert_eq!(title, "출석 체크 지각 임박!");
        assert_eq!(body, "마감까지 5분 남았습니다.");
    }

    #[test]
    fn 지각_잔여시간_0이면_지각_메시지를_생성한다() {
        let (title, body) = notification_message(DailyPhase::StartOverdue, Some(0));
        assert_eq!(title, "출석 체크 지각!");
        assert_eq!(body, "빨리 체크인하세요.");
    }

    #[test]
    fn 종료체크_필요시_종료_메시지를_생성한다() {
        let (title, body) = notification_message(DailyPhase::NeedEnd, Some(3600));
        assert_eq!(title, "학습 종료 체크가 필요합니다");
        assert_eq!(body, "마감까지 1시간 0분 남았습니다.");
    }

    #[test]
    fn 종료체크_시간_분_메시지를_생성한다() {
        let (title, body) = notification_message(DailyPhase::NeedEnd, Some(5400));
        assert_eq!(title, "학습 종료 체크가 필요합니다");
        assert_eq!(body, "마감까지 1시간 30분 남았습니다.");
    }

    #[test]
    fn 종료체크_분만_메시지를_생성한다() {
        let (title, body) = notification_message(DailyPhase::NeedEnd, Some(1800));
        assert_eq!(title, "학습 종료 체크가 필요합니다");
        assert_eq!(body, "마감까지 30분 남았습니다.");
    }

    #[test]
    fn 종료체크_잔여시간_없으면_기본_메시지를_생성한다() {
        let (title, body) = notification_message(DailyPhase::NeedEnd, None);
        assert_eq!(title, "학습 종료 체크가 필요합니다");
        assert_eq!(body, "학습 종료 체크를 해주세요.");
    }

    #[test]
    fn 기타_페이즈에서는_기본_메시지를_생성한다() {
        let (title, body) = notification_message(DailyPhase::Idle, None);
        assert_eq!(title, "Jungle Bell");
        assert_eq!(body, "출석 상태를 확인하세요.");
    }

    #[test]
    fn 학습중_페이즈에서는_기본_메시지를_생성한다() {
        let (title, body) = notification_message(DailyPhase::Studying, Some(3600));
        assert_eq!(title, "Jungle Bell");
        assert_eq!(body, "출석 상태를 확인하세요.");
    }

    #[test]
    fn 완료_페이즈에서는_기본_메시지를_생성한다() {
        let (title, body) = notification_message(DailyPhase::Complete, None);
        assert_eq!(title, "Jungle Bell");
        assert_eq!(body, "출석 상태를 확인하세요.");
    }

    #[test]
    fn 잔여시간_59초면_1분으로_올림_표시한다() {
        let (_, body) = notification_message(DailyPhase::NeedStart, Some(59));
        assert_eq!(body, "마감까지 1분 남았습니다.");
    }

    #[test]
    fn 잔여시간_10시간이면_시간_분_형식으로_표시한다() {
        let (_, body) = notification_message(DailyPhase::NeedStart, Some(36000));
        assert_eq!(body, "마감까지 10시간 0분 남았습니다.");
    }

    // --- compute_tick (통합) ---

    #[test]
    fn 데이터_미로드시_트레이는_없고_수집_job만_실행한다() {
        // given
        let mut state = default_state();

        // when
        let result = compute_tick(&mut state, kst_utc(9, 0, 0), false);

        // then
        assert_eq!(result.tick_interval, 5);
        assert!(result.tray_update.is_none());
        assert!(result.has_job_action(JobId::new("attendance_status_check")));
        assert!(!result.has_job_action(JobId::new("checker_session_refresh")));
        assert!(result.has_job_action(JobId::new("laundry_refresh")));
        assert!(result.has_job_action(JobId::new("meals_refresh")));
    }

    #[test]
    fn 스케줄러에는_알림_job을_등록하지_않는다() {
        assert_eq!(SCHEDULED_JOBS.len(), 4);
        assert!(SCHEDULED_JOBS.iter().all(|job| !job.id.name().contains("notification")));
    }

    #[test]
    fn 세탁_상태_job은_30초_간격으로_재실행된다() {
        let mut state = default_state();
        let started_at = kst_utc(9, 0, 0);
        let first = compute_tick(&mut state, started_at, false);
        let laundry_action = first
            .job_actions
            .iter()
            .find(|action| action.job.kind() == JobId::new("laundry_refresh"))
            .map(|action| action.job)
            .unwrap();
        record_job_result(&mut state, laundry_action, JobOutcome::Executed, started_at);

        let before_due = compute_tick(&mut state, started_at + chrono::Duration::seconds(29), false);
        let at_due = compute_tick(&mut state, started_at + chrono::Duration::seconds(30), false);

        assert!(!before_due.has_job_action(JobId::new("laundry_refresh")));
        assert!(at_due.has_job_action(JobId::new("laundry_refresh")));
    }

    #[test]
    fn 학습중_상태에서는_알림이_발송되지_않는다() {
        // given
        let mut state = default_state();
        state.data_loaded = true;
        state.morning_checked = true;

        // when
        let result = compute_tick(&mut state, kst_utc(12, 0, 0), false);

        // then
        assert_eq!(state.phase, DailyPhase::Studying);
        assert!(result.tray_update.is_some());
    }

    #[test]
    fn 진행중인_코호트가_없으면_idle로_처리하고_알림을_보내지_않는다() {
        // given
        let mut state = default_state();
        state.data_loaded = true;
        state.dday_status = DdayStatus::NoCohort;

        // when
        let result = compute_tick(&mut state, kst_utc(9, 30, 0), false);

        // then
        assert_eq!(state.phase, DailyPhase::Idle);
        assert!(result.tray_update.is_some());
    }

    #[test]
    fn 리로드_간격_경과시_리로드가_발생한다() {
        // given
        let mut state = default_state();
        state.data_loaded = true;
        let t0 = kst_utc(9, 0, 0);
        let result = compute_tick(&mut state, t0, false);
        assert!(!result.has_job_action(JobId::new("checker_session_refresh")));
        assert_eq!(
            state
                .interval_jobs
                .last_success_at(JobId::new("checker_session_refresh")),
            None
        );

        // when: 14분 후
        let t1 = kst_utc(9, 14, 0);
        let result_14min = compute_tick(&mut state, t1, false);

        // then: 아직 리로드 안 함
        assert!(!result_14min.has_job_action(JobId::new("checker_session_refresh")));

        // when: 16분 후
        let t2 = kst_utc(9, 16, 0);
        let result_16min = compute_tick(&mut state, t2, false);

        // then: 리로드 발생
        assert!(result_16min.has_job_action(JobId::new("checker_session_refresh")));
        assert_eq!(
            state
                .interval_jobs
                .last_success_at(JobId::new("checker_session_refresh")),
            None
        );
    }

    #[test]
    fn 리로드_필요_판단은_성공_전까지_마지막_리로드_시각을_유지한다() {
        // given
        let mut state = default_state();
        state.data_loaded = true;
        let t0 = kst_utc(9, 0, 0);
        state.interval_jobs.mark_success(&CHECKER_SESSION_REFRESH_JOB, t0);

        // when
        let t1 = kst_utc(9, 16, 0);
        let first = compute_tick(&mut state, t1, false);
        let t2 = kst_utc(9, 17, 0);
        let second = compute_tick(&mut state, t2, false);

        // then
        assert!(first.has_job_action(JobId::new("checker_session_refresh")));
        assert!(second.has_job_action(JobId::new("checker_session_refresh")));
        assert_eq!(
            state
                .interval_jobs
                .last_success_at(JobId::new("checker_session_refresh")),
            Some(t0)
        );
    }

    #[test]
    fn 틱_지연이_허용_범위_안이면_감지하지_않는다() {
        // given
        let previous = kst_utc(9, 0, 0);
        let now = previous + chrono::Duration::seconds(120);

        // when
        let delayed = tick_delayed(previous, 60, now);

        // then
        assert_eq!(delayed, None);
    }

    #[test]
    fn 틱_지연이_허용_범위를_넘으면_감지한다() {
        // given
        let previous = kst_utc(9, 0, 0);
        let now = previous + chrono::Duration::seconds(121);

        // when
        let delayed = tick_delayed(previous, 60, now);

        // then
        assert_eq!(delayed, Some(121));
    }

    #[test]
    fn 로그인_재시도_만료시_틱_간격이_늘어난다() {
        // given
        let mut state = default_state();
        state.data_loaded = true;
        state.needs_login = true;
        let now = kst_utc(9, 0, 0);
        state.login_retry_until = Some(now + chrono::Duration::seconds(180));

        // when: 재시도 윈도우 내
        let result = compute_tick(&mut state, now, false);

        // then
        assert!(state.login_retry_until.is_some());
        assert_eq!(result.tick_interval, 10);

        // when: 4분 후 만료
        let later = kst_utc(9, 4, 0);
        let result = compute_tick(&mut state, later, false);

        // then
        assert!(state.login_retry_until.is_none());
        assert_eq!(result.tick_interval, 600);
    }

    #[test]
    fn 일일_리셋시_체크_상태가_초기화된다() {
        // given
        let mut state = default_state();
        state.data_loaded = true;
        state.morning_checked = true;
        state.evening_checked = true;
        compute_tick(&mut state, kst_utc(23, 0, 0), false);
        assert!(state.morning_checked);

        // when: Day 2 05:00 — 리셋
        let day2 = FixedOffset::east_opt(9 * 3600)
            .unwrap()
            .with_ymd_and_hms(2026, 3, 18, 5, 0, 0)
            .unwrap()
            .with_timezone(&Utc);
        let result = compute_tick(&mut state, day2, false);

        // then
        assert!(result.daily_reset);
        assert!(!state.morning_checked);
        assert!(!state.evening_checked);
    }

    #[test]
    fn 페이즈_변경시_변경_플래그가_설정된다() {
        // given
        let mut state = default_state();
        state.data_loaded = true;
        state.phase = DailyPhase::NeedStart;
        state.morning_checked = true;

        // when: 체크인 완료 → Studying
        let result = compute_tick(&mut state, kst_utc(12, 0, 0), false);

        // then
        assert!(result.phase_changed);
        assert_eq!(state.phase, DailyPhase::Studying);
    }

    // --- StartOverdue 유예 구간 ---

    #[test]
    fn 지각_임박_10시5분에는_remaining이_300이다() {
        // given: 10:05 KST, morning_end=10:00 → grace_remaining = 10:10 - 10:05 = 300초
        let config = Config::default();
        let now = kst_utc(10, 5, 0);

        // when
        let (phase, remaining) = state::compute_daily_phase(&config, now, false, false);

        // then
        assert_eq!(phase, DailyPhase::StartOverdue);
        assert_eq!(remaining, Some(300));
    }

    #[test]
    fn 지각_10시15분에는_remaining이_none이다() {
        // given: 10:15 KST, morning_end=10:00 → grace_remaining = 10:10 - 10:15 = -300 → None
        let config = Config::default();
        let now = kst_utc(10, 15, 0);

        // when
        let (phase, remaining) = state::compute_daily_phase(&config, now, false, false);

        // then
        assert_eq!(phase, DailyPhase::StartOverdue);
        assert_eq!(remaining, None);
    }

    // --- skip_attendance ---

    #[test]
    fn 이번_출석_알림_끄기_활성화시_알림을_보내지_않는다() {
        // given
        let mut config = Config::default();
        config.skip_attendance = Some("2026-03-17".into()); // kst_dt의 날짜와 동일

        // when
        let d = should_notify(&config, DailyPhase::NeedStart, Some(3600), false, kst_dt(9, 30, 0));

        // then
        assert!(!d.send);
    }

    #[test]
    fn 이번_출석_알림_끄기_날짜가_다르면_알림이_발송된다() {
        // given: morning_start 이후에는 전날 skip이 무효
        let mut config = Config::default();
        config.skip_attendance = Some("2026-03-16".into()); // 어제 날짜

        // when: 09:30 (morning_start=04:00 이후)
        let d = should_notify(&config, DailyPhase::NeedStart, Some(3600), false, kst_dt(9, 30, 0));

        // then
        assert!(d.send);
    }

    #[test]
    fn 이번_출석_알림_끄기_자정_이후_morning_start_이전에는_전날_skip이_유효하다() {
        // given: 전날(03-17) skip 설정, 현재 03-18 02:00 (morning_start=04:00 이전)
        let mut config = Config::default();
        config.skip_attendance = Some("2026-03-17".into());
        let kst = FixedOffset::east_opt(9 * 3600)
            .unwrap()
            .with_ymd_and_hms(2026, 3, 18, 2, 0, 0)
            .unwrap();

        // when
        let d = should_notify(&config, DailyPhase::NeedEnd, Some(3600), false, kst);

        // then: morning_start 이전이므로 전날 skip이 아직 유효
        assert!(!d.send);
    }

    #[test]
    fn 이번_출석_알림_끄기_morning_start_이후에는_전날_skip이_해제된다() {
        // given: 전날(03-17) skip 설정, 현재 03-18 09:30 (morning_start=04:00 이후, 알림윈도우 내)
        let mut config = Config::default();
        config.skip_attendance = Some("2026-03-17".into());
        let kst = FixedOffset::east_opt(9 * 3600)
            .unwrap()
            .with_ymd_and_hms(2026, 3, 18, 9, 30, 0)
            .unwrap();

        // when
        let d = should_notify(&config, DailyPhase::NeedStart, Some(3600), false, kst);

        // then: morning_start 이후이므로 전날 skip은 무효
        assert!(d.send);
    }

    // --- skip_sunday ---

    #[test]
    fn 일요일_알림_끄기_활성화시_일요일에_알림을_보내지_않는다() {
        // given: 2026-03-22는 일요일
        let mut config = Config::default();
        config.skip_sunday = true;
        let sunday = FixedOffset::east_opt(9 * 3600)
            .unwrap()
            .with_ymd_and_hms(2026, 3, 22, 9, 30, 0)
            .unwrap();

        // when
        let d = should_notify(&config, DailyPhase::NeedStart, Some(3600), false, sunday);

        // then
        assert!(!d.send);
    }

    #[test]
    fn 일요일_알림_끄기_활성화시_월요일에는_알림이_발송된다() {
        // given: 2026-03-23는 월요일
        let mut config = Config::default();
        config.skip_sunday = true;
        let monday = FixedOffset::east_opt(9 * 3600)
            .unwrap()
            .with_ymd_and_hms(2026, 3, 23, 9, 30, 0)
            .unwrap();

        // when
        let d = should_notify(&config, DailyPhase::NeedStart, Some(3600), false, monday);

        // then
        assert!(d.send);
    }

    #[test]
    fn 일요일_알림_끄기_비활성화시_일요일에도_알림이_발송된다() {
        // given
        let config = Config::default(); // skip_sunday = false
        let sunday = FixedOffset::east_opt(9 * 3600)
            .unwrap()
            .with_ymd_and_hms(2026, 3, 22, 9, 30, 0)
            .unwrap();

        // when
        let d = should_notify(&config, DailyPhase::NeedStart, Some(3600), false, sunday);

        // then
        assert!(d.send);
    }

    #[test]
    fn 이번_출석_알림_끄기_미설정시_알림이_발송된다() {
        // given
        let config = Config::default(); // skip_attendance = None

        // when
        let d = should_notify(&config, DailyPhase::NeedStart, Some(3600), false, kst_dt(9, 30, 0));

        // then
        assert!(d.send);
    }

    #[test]
    fn 지각_정확히_10시10분에는_remaining이_none이다() {
        // given: 10:10:00 → grace_remaining = 0 → None
        let config = Config::default();
        let now = kst_utc(10, 10, 0);

        // when
        let (phase, remaining) = state::compute_daily_phase(&config, now, false, false);

        // then
        assert_eq!(phase, DailyPhase::StartOverdue);
        assert_eq!(remaining, None);
    }
}
