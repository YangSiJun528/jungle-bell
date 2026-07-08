//! Interval job engine.
//!
//! scheduler는 이 모듈로 "언제 실행할지"만 판단하고,
//! 각 job의 실제 부수효과는 runtime adapter에서 수행한다.

use std::collections::BTreeMap;

use chrono::{DateTime, Duration, Utc};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub(crate) enum JobKind {
    AttendanceStatusCheck,
    CheckerSessionRefresh,
}

impl JobKind {
    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::AttendanceStatusCheck => "attendance_status_check",
            Self::CheckerSessionRefresh => "checker_session_refresh",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct JobSpec {
    pub(crate) kind: JobKind,
    pub(crate) interval_secs: u64,
    pub(crate) initial_delay_secs: u64,
    pub(crate) backoff_base_secs: u64,
    pub(crate) backoff_max_secs: u64,
    pub(crate) max_failures: u32,
}

impl JobSpec {
    pub(crate) const fn new(kind: JobKind, interval_secs: u64) -> Self {
        Self {
            kind,
            interval_secs,
            initial_delay_secs: interval_secs,
            backoff_base_secs: interval_secs,
            backoff_max_secs: interval_secs,
            max_failures: u32::MAX,
        }
    }

    pub(crate) const fn initial_delay_secs(mut self, seconds: u64) -> Self {
        self.initial_delay_secs = seconds;
        self
    }

    pub(crate) const fn backoff_secs(mut self, base: u64, max: u64) -> Self {
        self.backoff_base_secs = base;
        self.backoff_max_secs = max;
        self
    }

    pub(crate) const fn max_failures(mut self, max_failures: u32) -> Self {
        self.max_failures = max_failures;
        self
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum JobActionReason {
    Initial,
    IntervalDue,
    RetryDue,
    DelayedTick,
    Tick,
}

impl JobActionReason {
    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Initial => "initial",
            Self::IntervalDue => "interval due",
            Self::RetryDue => "retry due",
            Self::DelayedTick => "delayed tick",
            Self::Tick => "tick",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct JobAction {
    kind: JobKind,
    reason: JobActionReason,
}

impl JobAction {
    pub(crate) const fn new(kind: JobKind, reason: JobActionReason) -> Self {
        Self { kind, reason }
    }

    pub(crate) fn kind(self) -> JobKind {
        self.kind
    }

    pub(crate) fn reason(self) -> JobActionReason {
        self.reason
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum JobSkipReason {
    Scheduled,
    NotDue,
    BackingOff,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum JobDecision {
    Run(JobAction),
    Skip {
        kind: JobKind,
        reason: JobSkipReason,
        next_due_at: Option<DateTime<Utc>>,
    },
    GiveUp {
        kind: JobKind,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum JobFailureDecision {
    RetryAt(DateTime<Utc>),
    GiveUp { kind: JobKind },
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(crate) struct JobRuntime {
    pub(crate) next_due_at: Option<DateTime<Utc>>,
    pub(crate) last_success_at: Option<DateTime<Utc>>,
    pub(crate) last_failure_at: Option<DateTime<Utc>>,
    pub(crate) consecutive_failures: u32,
    pub(crate) given_up: bool,
}

impl JobRuntime {
    pub(crate) fn mark_success(&mut self, spec: &JobSpec, now: DateTime<Utc>) {
        self.last_success_at = Some(now);
        self.consecutive_failures = 0;
        self.given_up = false;
        self.next_due_at = Some(add_secs(now, spec.interval_secs));
    }

    pub(crate) fn mark_failure(&mut self, spec: &JobSpec, now: DateTime<Utc>) -> JobFailureDecision {
        self.last_failure_at = Some(now);
        self.consecutive_failures = self.consecutive_failures.saturating_add(1);

        if self.consecutive_failures >= spec.max_failures {
            self.given_up = true;
            self.next_due_at = None;
            return JobFailureDecision::GiveUp { kind: spec.kind };
        }

        let next_due_at = add_secs(now, backoff_delay_secs(spec, self.consecutive_failures));
        self.next_due_at = Some(next_due_at);
        JobFailureDecision::RetryAt(next_due_at)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(crate) struct JobStore {
    runtimes: BTreeMap<JobKind, JobRuntime>,
}

impl JobStore {
    #[cfg(test)]
    pub(crate) fn last_success_at(&self, kind: JobKind) -> Option<DateTime<Utc>> {
        self.runtimes.get(&kind).and_then(|runtime| runtime.last_success_at)
    }

    pub(crate) fn mark_success(&mut self, spec: &JobSpec, now: DateTime<Utc>) {
        self.runtimes.entry(spec.kind).or_default().mark_success(spec, now);
    }

    pub(crate) fn mark_failure(&mut self, spec: &JobSpec, now: DateTime<Utc>) -> JobFailureDecision {
        self.runtimes.entry(spec.kind).or_default().mark_failure(spec, now)
    }

    pub(crate) fn collect_due_actions(&mut self, now: DateTime<Utc>, specs: &[JobSpec]) -> Vec<JobAction> {
        specs
            .iter()
            .filter_map(|spec| match self.decide(spec, now) {
                JobDecision::Run(action) => Some(action),
                JobDecision::Skip { .. } | JobDecision::GiveUp { .. } => None,
            })
            .collect()
    }

    pub(crate) fn decide(&mut self, spec: &JobSpec, now: DateTime<Utc>) -> JobDecision {
        decide_job(spec, self.runtimes.entry(spec.kind).or_default(), now)
    }
}

pub(crate) fn decide_job(spec: &JobSpec, runtime: &mut JobRuntime, now: DateTime<Utc>) -> JobDecision {
    if runtime.given_up {
        return JobDecision::GiveUp { kind: spec.kind };
    }

    let Some(next_due_at) = runtime.next_due_at else {
        let next_due_at = add_secs(now, spec.initial_delay_secs);
        runtime.next_due_at = Some(next_due_at);
        if spec.initial_delay_secs == 0 {
            return JobDecision::Run(JobAction::new(spec.kind, JobActionReason::Initial));
        }
        return JobDecision::Skip {
            kind: spec.kind,
            reason: JobSkipReason::Scheduled,
            next_due_at: Some(next_due_at),
        };
    };

    if now < next_due_at {
        return JobDecision::Skip {
            kind: spec.kind,
            reason: if runtime.consecutive_failures > 0 {
                JobSkipReason::BackingOff
            } else {
                JobSkipReason::NotDue
            },
            next_due_at: Some(next_due_at),
        };
    }

    let reason = if runtime.consecutive_failures > 0 {
        JobActionReason::RetryDue
    } else {
        JobActionReason::IntervalDue
    };
    JobDecision::Run(JobAction::new(spec.kind, reason))
}

pub(crate) fn delayed_tick_action(
    previous_tick: DateTime<Utc>,
    expected_interval_secs: u64,
    now: DateTime<Utc>,
    grace_secs: u64,
    kind: JobKind,
) -> Option<JobAction> {
    let elapsed = (now - previous_tick).num_seconds();
    let threshold = expected_interval_secs.saturating_add(grace_secs) as i64;

    (elapsed > threshold).then_some(JobAction::new(kind, JobActionReason::DelayedTick))
}

fn add_secs(now: DateTime<Utc>, seconds: u64) -> DateTime<Utc> {
    now + Duration::seconds(seconds.min(i64::MAX as u64) as i64)
}

fn backoff_delay_secs(spec: &JobSpec, consecutive_failures: u32) -> u64 {
    let exponent = consecutive_failures.saturating_sub(1).min(31);
    let multiplier = 1_u64 << exponent;
    spec.backoff_base_secs
        .saturating_mul(multiplier)
        .min(spec.backoff_max_secs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{TimeZone, Utc};

    const TEST_TASK: JobSpec = JobSpec::new(JobKind::CheckerSessionRefresh, 60);

    fn utc(h: u32, m: u32, s: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 3, 17, h, m, s).unwrap()
    }

    #[test]
    fn 첫_평가는_initialize이고_due가_아니다() {
        let mut runtime = JobRuntime::default();

        let decision = decide_job(&TEST_TASK, &mut runtime, utc(9, 0, 0));

        assert_eq!(
            decision,
            JobDecision::Skip {
                kind: JobKind::CheckerSessionRefresh,
                reason: JobSkipReason::Scheduled,
                next_due_at: Some(utc(9, 1, 0)),
            }
        );
    }

    #[test]
    fn 간격_전에는_wait이다() {
        let mut runtime = JobRuntime {
            next_due_at: Some(utc(9, 1, 0)),
            ..Default::default()
        };

        let decision = decide_job(&TEST_TASK, &mut runtime, utc(9, 0, 59));

        assert_eq!(
            decision,
            JobDecision::Skip {
                kind: JobKind::CheckerSessionRefresh,
                reason: JobSkipReason::NotDue,
                next_due_at: Some(utc(9, 1, 0)),
            }
        );
    }

    #[test]
    fn 간격_이후에는_due이다() {
        let mut runtime = JobRuntime {
            next_due_at: Some(utc(9, 1, 0)),
            ..Default::default()
        };

        let decision = decide_job(&TEST_TASK, &mut runtime, utc(9, 1, 0));

        assert_eq!(
            decision,
            JobDecision::Run(JobAction::new(
                JobKind::CheckerSessionRefresh,
                JobActionReason::IntervalDue,
            ))
        );
    }

    #[test]
    fn 시간이_뒤로_가면_wait이다() {
        let mut runtime = JobRuntime {
            next_due_at: Some(utc(9, 1, 0)),
            ..Default::default()
        };

        let decision = decide_job(&TEST_TASK, &mut runtime, utc(9, 0, 0));

        assert_eq!(
            decision,
            JobDecision::Skip {
                kind: JobKind::CheckerSessionRefresh,
                reason: JobSkipReason::NotDue,
                next_due_at: Some(utc(9, 1, 0)),
            }
        );
    }

    #[test]
    fn 첫_collect는_기준시각만_저장하고_실행하지_않는다() {
        let mut store = JobStore::default();
        let actions = store.collect_due_actions(utc(9, 0, 0), &[TEST_TASK]);

        assert!(actions.is_empty());
        assert_eq!(
            store
                .runtimes
                .get(&JobKind::CheckerSessionRefresh)
                .and_then(|runtime| runtime.next_due_at),
            Some(utc(9, 1, 0))
        );
    }

    #[test]
    fn 간격이_지나면_action을_반환하고_성공시각은_갱신하지_않는다() {
        let mut store = JobStore::default();
        store.mark_success(&TEST_TASK, utc(9, 0, 0));

        let actions = store.collect_due_actions(utc(9, 1, 0), &[TEST_TASK]);

        assert_eq!(actions.len(), 1);
        assert_eq!(actions[0].kind(), JobKind::CheckerSessionRefresh);
        assert_eq!(
            store.last_success_at(JobKind::CheckerSessionRefresh),
            Some(utc(9, 0, 0))
        );
    }

    #[test]
    fn job_engine은_initial_delay_due_success를_분리한다() {
        let spec = JobSpec::new(JobKind::CheckerSessionRefresh, 60)
            .initial_delay_secs(60)
            .max_failures(3);
        let mut runtime = JobRuntime::default();

        assert_eq!(
            decide_job(&spec, &mut runtime, utc(9, 0, 0)),
            JobDecision::Skip {
                kind: JobKind::CheckerSessionRefresh,
                reason: JobSkipReason::Scheduled,
                next_due_at: Some(utc(9, 1, 0)),
            }
        );
        assert_eq!(
            decide_job(&spec, &mut runtime, utc(9, 0, 59)),
            JobDecision::Skip {
                kind: JobKind::CheckerSessionRefresh,
                reason: JobSkipReason::NotDue,
                next_due_at: Some(utc(9, 1, 0)),
            }
        );
        assert_eq!(
            decide_job(&spec, &mut runtime, utc(9, 1, 0)),
            JobDecision::Run(JobAction::new(
                JobKind::CheckerSessionRefresh,
                JobActionReason::IntervalDue,
            ))
        );

        runtime.mark_success(&spec, utc(9, 1, 5));

        assert_eq!(runtime.last_success_at, Some(utc(9, 1, 5)));
        assert_eq!(runtime.next_due_at, Some(utc(9, 2, 5)));
        assert_eq!(runtime.consecutive_failures, 0);
    }

    #[test]
    fn job_engine은_failure_backoff와_give_up을_계산한다() {
        let spec = JobSpec::new(JobKind::CheckerSessionRefresh, 60)
            .initial_delay_secs(0)
            .backoff_secs(10, 40)
            .max_failures(3);
        let mut runtime = JobRuntime::default();

        assert_eq!(
            decide_job(&spec, &mut runtime, utc(9, 0, 0)),
            JobDecision::Run(JobAction::new(JobKind::CheckerSessionRefresh, JobActionReason::Initial,))
        );

        assert_eq!(
            runtime.mark_failure(&spec, utc(9, 0, 0)),
            JobFailureDecision::RetryAt(utc(9, 0, 10))
        );
        assert_eq!(
            runtime.mark_failure(&spec, utc(9, 0, 10)),
            JobFailureDecision::RetryAt(utc(9, 0, 30))
        );
        assert_eq!(
            runtime.mark_failure(&spec, utc(9, 0, 30)),
            JobFailureDecision::GiveUp {
                kind: JobKind::CheckerSessionRefresh
            }
        );
        assert_eq!(
            decide_job(&spec, &mut runtime, utc(9, 1, 0)),
            JobDecision::GiveUp {
                kind: JobKind::CheckerSessionRefresh
            }
        );
    }

    #[test]
    fn delayed_tick은_복구_job_action으로_표현된다() {
        let action = delayed_tick_action(utc(9, 0, 0), 60, utc(9, 2, 1), 60, JobKind::CheckerSessionRefresh);

        assert_eq!(
            action,
            Some(JobAction::new(
                JobKind::CheckerSessionRefresh,
                JobActionReason::DelayedTick,
            ))
        );
    }
}
