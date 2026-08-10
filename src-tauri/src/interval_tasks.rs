//! Jungle Bell이 실제 사용하는 세 개 반복 작업을 위한 작은 스케줄 상태 저장소.

use std::collections::BTreeMap;

use chrono::{DateTime, FixedOffset, Utc};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub(crate) struct JobId(&'static str);

impl JobId {
    pub(crate) const fn new(value: &'static str) -> Self {
        assert!(!value.is_empty(), "job id must not be empty");
        Self(value)
    }

    pub(crate) const fn name(self) -> &'static str {
        self.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Trigger {
    Every { interval_secs: u64 },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct JobSpec {
    pub(crate) kind: JobId,
    pub(crate) trigger: Trigger,
    initial_delay_secs: u64,
    backoff_base_secs: u64,
    backoff_max_secs: u64,
    max_failures: u32,
}

impl JobSpec {
    pub(crate) const fn new(kind: JobId, interval_secs: u64) -> Self {
        assert!(interval_secs > 0, "job interval must be positive");
        Self {
            kind,
            trigger: Trigger::Every { interval_secs },
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
        assert!(base > 0 && max >= base, "invalid job backoff");
        self.backoff_base_secs = base;
        self.backoff_max_secs = max;
        self
    }

    pub(crate) const fn max_failures(mut self, failures: u32) -> Self {
        assert!(failures > 0, "max failures must be positive");
        self.max_failures = failures;
        self
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum JobActionReason {
    Initial,
    IntervalDue,
    RetryDue,
    DelayedTick,
}

impl JobActionReason {
    pub(crate) const fn label(self) -> &'static str {
        match self {
            Self::Initial => "initial",
            Self::IntervalDue => "interval due",
            Self::RetryDue => "retry due",
            Self::DelayedTick => "delayed tick",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct JobAction {
    kind: JobId,
    reason: JobActionReason,
}

impl JobAction {
    pub(crate) const fn new(kind: JobId, reason: JobActionReason) -> Self {
        Self { kind, reason }
    }

    pub(crate) const fn kind(self) -> JobId {
        self.kind
    }

    pub(crate) const fn reason(self) -> JobActionReason {
        self.reason
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum JobSkipReason {
    NotDue,
    ConditionFalse,
    BackingOff,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum JobDecision {
    Run(JobAction),
    Skip {
        kind: JobId,
        reason: JobSkipReason,
        next_due_at: Option<DateTime<Utc>>,
    },
    GiveUp {
        kind: JobId,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum JobFailureDecision {
    RetryAt(DateTime<Utc>),
    GiveUp { kind: JobId },
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct JobEvaluation {
    now: DateTime<Utc>,
    condition_active: bool,
}

impl JobEvaluation {
    pub(crate) const fn new(
        now: DateTime<Utc>,
        _local_now: DateTime<FixedOffset>,
        _attendance_day: &str,
        condition_active: bool,
    ) -> Self {
        Self { now, condition_active }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
struct JobRuntime {
    next_due_at: Option<DateTime<Utc>>,
    last_success_at: Option<DateTime<Utc>>,
    consecutive_failures: u32,
    given_up: bool,
    initialized: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(crate) struct JobStore {
    jobs: BTreeMap<JobId, JobRuntime>,
}

impl JobStore {
    pub(crate) fn decide_with_context(&mut self, spec: &JobSpec, evaluation: &JobEvaluation) -> JobDecision {
        let runtime = self.jobs.entry(spec.kind).or_default();
        if !runtime.initialized {
            runtime.initialized = true;
            runtime.next_due_at = Some(evaluation.now + seconds(spec.initial_delay_secs));
        }

        if runtime.given_up {
            return JobDecision::GiveUp { kind: spec.kind };
        }
        if !evaluation.condition_active {
            return JobDecision::Skip {
                kind: spec.kind,
                reason: JobSkipReason::ConditionFalse,
                next_due_at: runtime.next_due_at,
            };
        }
        if runtime.next_due_at.is_some_and(|due| due > evaluation.now) {
            return JobDecision::Skip {
                kind: spec.kind,
                reason: if runtime.consecutive_failures > 0 {
                    JobSkipReason::BackingOff
                } else {
                    JobSkipReason::NotDue
                },
                next_due_at: runtime.next_due_at,
            };
        }

        let reason = if runtime.consecutive_failures > 0 {
            JobActionReason::RetryDue
        } else if runtime.last_success_at.is_none() {
            JobActionReason::Initial
        } else {
            JobActionReason::IntervalDue
        };
        JobDecision::Run(JobAction::new(spec.kind, reason))
    }

    pub(crate) fn mark_success_with_context(&mut self, spec: &JobSpec, evaluation: &JobEvaluation) {
        let runtime = self.jobs.entry(spec.kind).or_default();
        runtime.initialized = true;
        runtime.last_success_at = Some(evaluation.now);
        runtime.consecutive_failures = 0;
        runtime.given_up = false;
        runtime.next_due_at = next_regular_due(spec, evaluation.now);
    }

    pub(crate) fn mark_not_eligible_with_context(&mut self, spec: &JobSpec, evaluation: &JobEvaluation) {
        let runtime = self.jobs.entry(spec.kind).or_default();
        runtime.initialized = true;
        runtime.consecutive_failures = 0;
        runtime.next_due_at = next_regular_due(spec, evaluation.now);
    }

    pub(crate) fn mark_failure(&mut self, spec: &JobSpec, now: DateTime<Utc>) -> JobFailureDecision {
        let runtime = self.jobs.entry(spec.kind).or_default();
        runtime.initialized = true;
        runtime.consecutive_failures = runtime.consecutive_failures.saturating_add(1);
        if runtime.consecutive_failures >= spec.max_failures {
            runtime.given_up = true;
            runtime.next_due_at = None;
            return JobFailureDecision::GiveUp { kind: spec.kind };
        }

        let exponent = runtime.consecutive_failures.saturating_sub(1).min(31);
        let delay = spec
            .backoff_base_secs
            .saturating_mul(1_u64 << exponent)
            .min(spec.backoff_max_secs);
        let next_due_at = now + seconds(delay);
        runtime.next_due_at = Some(next_due_at);
        JobFailureDecision::RetryAt(next_due_at)
    }

    #[cfg(test)]
    pub(crate) fn mark_success(&mut self, spec: &JobSpec, now: DateTime<Utc>) {
        let local_now = now.with_timezone(&FixedOffset::east_opt(0).unwrap());
        let evaluation = JobEvaluation::new(now, local_now, "", true);
        self.mark_success_with_context(spec, &evaluation);
    }

    #[cfg(test)]
    pub(crate) fn last_success_at(&self, kind: JobId) -> Option<DateTime<Utc>> {
        self.jobs.get(&kind).and_then(|runtime| runtime.last_success_at)
    }

    pub(crate) fn next_due_at_for(&self, specs: &[JobSpec]) -> Option<DateTime<Utc>> {
        specs
            .iter()
            .filter_map(|spec| self.jobs.get(&spec.kind)?.next_due_at)
            .min()
    }
}

fn next_regular_due(spec: &JobSpec, now: DateTime<Utc>) -> Option<DateTime<Utc>> {
    match spec.trigger {
        Trigger::Every { interval_secs } => Some(now + seconds(interval_secs)),
    }
}

fn seconds(value: u64) -> chrono::Duration {
    chrono::Duration::seconds(i64::try_from(value).unwrap_or(i64::MAX))
}

pub(crate) fn delayed_tick_action(
    previous_tick: DateTime<Utc>,
    expected_interval_secs: u64,
    now: DateTime<Utc>,
    grace_secs: u64,
    kind: JobId,
) -> Option<JobAction> {
    let threshold = i64::try_from(expected_interval_secs.saturating_add(grace_secs)).unwrap_or(i64::MAX);
    ((now - previous_tick).num_seconds() > threshold).then_some(JobAction::new(kind, JobActionReason::DelayedTick))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn at(minute: u32, second: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 8, 10, 0, minute, second).unwrap()
    }

    fn evaluation(now: DateTime<Utc>) -> JobEvaluation {
        JobEvaluation::new(now, now.with_timezone(&FixedOffset::east_opt(0).unwrap()), "", true)
    }

    #[test]
    fn 즉시_작업은_첫_평가에_실행하고_성공후_간격을_지킨다() {
        let spec = JobSpec::new(JobId::new("laundry"), 30).initial_delay_secs(0);
        let mut store = JobStore::default();
        let start = at(0, 0);
        assert!(matches!(
            store.decide_with_context(&spec, &evaluation(start)),
            JobDecision::Run(_)
        ));
        store.mark_success(&spec, start);
        assert!(matches!(
            store.decide_with_context(&spec, &evaluation(at(0, 29))),
            JobDecision::Skip { .. }
        ));
        assert!(matches!(
            store.decide_with_context(&spec, &evaluation(at(0, 30))),
            JobDecision::Run(_)
        ));
    }

    #[test]
    fn 지연_시작과_실패_backoff를_적용한다() {
        let spec = JobSpec::new(JobId::new("checker"), 300)
            .initial_delay_secs(300)
            .backoff_secs(30, 300)
            .max_failures(3);
        let mut store = JobStore::default();
        let start = at(0, 0);
        assert!(matches!(
            store.decide_with_context(&spec, &evaluation(start)),
            JobDecision::Skip { .. }
        ));
        assert!(matches!(
            store.decide_with_context(&spec, &evaluation(at(5, 0))),
            JobDecision::Run(_)
        ));
        assert_eq!(
            store.mark_failure(&spec, at(5, 0)),
            JobFailureDecision::RetryAt(at(5, 30))
        );
    }

    #[test]
    fn 절전_복귀_지연은_예상_간격과_grace를_넘을때만_감지한다() {
        let start = at(0, 0);
        assert!(delayed_tick_action(start, 60, at(2, 0), 60, JobId::new("checker")).is_none());
        assert!(delayed_tick_action(start, 60, at(2, 1), 60, JobId::new("checker")).is_some());
    }
}
