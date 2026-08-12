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
use crate::interval_tasks::{self, JobAction, JobEvaluation, JobFailureDecision, JobId, JobSpec};
use crate::runtime::{self, JobOutcome, RuntimeAction, ScheduledAction};
use crate::state::{kst, AppState, DailyPhase, TraySnapshot};

#[cfg(test)]
use crate::state;

/// 액션 필요 시 틱 간격 (초). API 호출 빈도를 줄이기 위해 60초.
const TICK_INTERVAL_ACTIVE: u64 = 60;
/// 대기 시 틱 간격 (초). 5분 간격으로 상태 확인.
const TICK_INTERVAL_IDLE: u64 = 300;

/// 체커 WebView 세션 상태를 5분 간격으로 새로 확인한다.
const RELOAD_INTERVAL_NORMAL: u64 = 5 * 60;
const CHECKER_SESSION_REFRESH_ID: JobId = JobId::new("checker_session_refresh");

const CHECKER_SESSION_REFRESH_JOB: JobSpec = JobSpec::new(CHECKER_SESSION_REFRESH_ID, RELOAD_INTERVAL_NORMAL)
    .initial_delay_secs(RELOAD_INTERVAL_NORMAL)
    .backoff_secs(30, 5 * 60)
    .max_failures(3);

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

fn fixed_checker_refresh_spec(_state: &AppState) -> JobSpec {
    CHECKER_SESSION_REFRESH_JOB
}

fn always_eligible(_state: &AppState, _context: &SchedulerContext) -> bool {
    true
}

fn checker_refresh_action(_state: &AppState, _context: &SchedulerContext) -> RuntimeAction {
    RuntimeAction::CheckerSessionRefresh
}

const SCHEDULED_JOBS: [RegisteredJob; 1] = [RegisteredJob {
    id: CHECKER_SESSION_REFRESH_ID,
    spec: fixed_checker_refresh_spec,
    condition: always_eligible,
    action: checker_refresh_action,
    conflict_key: Some("checker-session"),
    priority: 100,
}];

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
    let attendance_date = attendance_day::effective_attendance_date(kst_now);
    let evaluation = JobEvaluation::new(now, kst_now, &attendance_date, true);
    let spec = (job.spec)(state);

    match outcome {
        JobOutcome::Executed => {
            state.interval_jobs.mark_success_with_context(&spec, &evaluation);
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

fn scheduler_context(now: DateTime<Utc>) -> SchedulerContext {
    let kst_now = now.with_timezone(&kst());
    SchedulerContext {
        now,
        kst_now,
        attendance_date: attendance_day::effective_attendance_date(kst_now),
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
        if current_day != last_day && current_hour >= crate::config::MORNING_START_HOUR {
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

/// 적응형 틱 간격 계산 (순수 함수).
pub(crate) fn compute_tick_interval(
    data_loaded: bool,
    needs_login: bool,
    checker_visible: bool,
    phase: DailyPhase,
    remaining: Option<i64>,
) -> u64 {
    let base_interval = if !data_loaded {
        5
    } else if needs_login {
        if checker_visible {
            10
        } else {
            600
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

/// 스케줄러 틱 한 번의 순수 계산.
///
/// 상태를 갱신하고, 부수효과 지시를 `TickResult`로 반환.
/// 실제 부수효과(tray 갱신, 알림 발송, WebView 리로드)는 호출자가 수행.
pub(crate) fn compute_tick(state: &mut AppState, now: DateTime<Utc>, checker_visible: bool) -> TickResult {
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
    let context = scheduler_context(now);
    let job_actions = compute_job_actions(state, &context);

    // --- 적응형 틱 간격 ---
    let tick_interval = compute_tick_interval(
        state.data_loaded,
        state.needs_login,
        checker_visible,
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
        log::info!(
            "[scheduler] fixed attendance schedule: day_start={:02}:{:02} start_deadline={:02}:{:02} end_open={:02}:{:02} day_end={:02}:{:02}",
            crate::config::MORNING_START_HOUR,
            crate::config::MORNING_START_MINUTE,
            crate::config::MORNING_END_HOUR,
            crate::config::MORNING_END_MINUTE,
            crate::config::EVENING_START_HOUR,
            crate::config::EVENING_START_MINUTE,
            crate::config::EVENING_END_HOUR,
            crate::config::EVENING_END_MINUTE,
        );

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
                let checker_visible = app_handle
                    .get_webview_window("checker")
                    .and_then(|window| window.is_visible().ok())
                    .unwrap_or(false);

                let result = compute_tick(&mut s, now, checker_visible);
                let phase = s.phase;

                log_tick_state(now, &s, &result);
                (result, phase)
            };

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

    // --- compute_tick_interval ---

    #[test]
    fn 데이터_미로드시_틱_간격은_5초이다() {
        // given & when
        let result = compute_tick_interval(false, false, false, DailyPhase::Idle, None);

        // then
        assert_eq!(result, 5);
    }

    #[test]
    fn 로그인_필요하고_checker가_보이면_틱_간격은_10초이다() {
        // given & when
        let result = compute_tick_interval(true, true, true, DailyPhase::Idle, None);

        // then
        assert_eq!(result, 10);
    }

    #[test]
    fn 로그인_필요하고_checker가_숨겨져있으면_틱_간격은_600초이다() {
        // given & when
        let result = compute_tick_interval(true, true, false, DailyPhase::Idle, None);

        // then
        assert_eq!(result, 600);
    }

    #[test]
    fn 액티브_페이즈에서_틱_간격은_활성_간격이다() {
        // given & when
        let result = compute_tick_interval(true, false, false, DailyPhase::NeedStart, Some(3600));

        // then
        assert_eq!(result, TICK_INTERVAL_ACTIVE);
    }

    #[test]
    fn 유휴_페이즈에서_틱_간격은_유휴_간격이다() {
        // given & when
        let result = compute_tick_interval(true, false, false, DailyPhase::Studying, Some(1800));

        // then
        assert_eq!(result, TICK_INTERVAL_IDLE);
    }

    #[test]
    fn 잔여시간이_기본_간격보다_짧으면_잔여시간_플러스_1이다() {
        // given & when: remaining=30 < base=60 → 31
        let result = compute_tick_interval(true, false, false, DailyPhase::NeedStart, Some(30));

        // then
        assert_eq!(result, 31);
    }

    #[test]
    fn 잔여시간이_0이면_기본_간격을_사용한다() {
        // given & when
        let result = compute_tick_interval(true, false, false, DailyPhase::NeedStart, Some(0));

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

    // --- compute_tick (통합) ---

    #[test]
    fn 데이터_미로드시_트레이와_서버데이터_job은_실행하지_않는다() {
        // given
        let mut state = default_state();

        // when
        let result = compute_tick(&mut state, kst_utc(9, 0, 0), false);

        // then
        assert_eq!(result.tick_interval, 5);
        assert!(result.tray_update.is_none());
        assert!(!result.has_job_action(JobId::new("checker_session_refresh")));
        assert!(!result.has_job_action(JobId::new("laundry_refresh")));
        assert!(!result.has_job_action(JobId::new("meals_refresh")));
    }

    #[test]
    fn 출석은_별도_on_tick_job없이_5분_checker_refresh로_수집한다() {
        assert_eq!(SCHEDULED_JOBS.len(), 1);
        assert!(SCHEDULED_JOBS
            .iter()
            .all(|job| job.id.name() != "attendance_status_check"));
        assert!(SCHEDULED_JOBS.iter().all(|job| !job.id.name().contains("notification")));
        assert_eq!(
            CHECKER_SESSION_REFRESH_JOB.trigger,
            interval_tasks::Trigger::Every { interval_secs: 5 * 60 }
        );
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

        // when: 4분 후
        let t1 = kst_utc(9, 4, 0);
        let result_4min = compute_tick(&mut state, t1, false);

        // then: 아직 리로드 안 함
        assert!(!result_4min.has_job_action(JobId::new("checker_session_refresh")));

        // when: 6분 후
        let t2 = kst_utc(9, 6, 0);
        let result_6min = compute_tick(&mut state, t2, false);

        // then: 리로드 발생
        assert!(result_6min.has_job_action(JobId::new("checker_session_refresh")));
        assert_eq!(
            CHECKER_SESSION_REFRESH_JOB.trigger,
            interval_tasks::Trigger::Every { interval_secs: 5 * 60 }
        );
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
        let t1 = kst_utc(9, 6, 0);
        let first = compute_tick(&mut state, t1, false);
        let t2 = kst_utc(9, 7, 0);
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
        let now = kst_utc(10, 5, 0);

        // when
        let (phase, remaining) = state::compute_daily_phase(now, false, false);

        // then
        assert_eq!(phase, DailyPhase::StartOverdue);
        assert_eq!(remaining, Some(300));
    }

    #[test]
    fn 지각_10시15분에는_remaining이_none이다() {
        // given: 10:15 KST, morning_end=10:00 → grace_remaining = 10:10 - 10:15 = -300 → None
        let now = kst_utc(10, 15, 0);

        // when
        let (phase, remaining) = state::compute_daily_phase(now, false, false);

        // then
        assert_eq!(phase, DailyPhase::StartOverdue);
        assert_eq!(remaining, None);
    }

    #[test]
    fn 지각_정확히_10시10분에는_remaining이_none이다() {
        // given: 10:10:00 → grace_remaining = 0 → None
        let now = kst_utc(10, 10, 0);

        // when
        let (phase, remaining) = state::compute_daily_phase(now, false, false);

        // then
        assert_eq!(phase, DailyPhase::StartOverdue);
        assert_eq!(remaining, None);
    }
}
