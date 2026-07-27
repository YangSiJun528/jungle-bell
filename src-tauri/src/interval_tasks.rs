//! Interval job engine.
//!
//! scheduler는 이 모듈로 "언제 실행할지"만 판단하고,
//! 각 job의 실제 부수효과는 runtime adapter에서 수행한다.
//!
//! 동작 규약 참고:
//! - Quartz `DailyTimeIntervalTrigger`의 일일 구간 반복:
//!   https://github.com/quartz-scheduler/quartz/blob/9294eac4c3b6cda8e54b0c94b6b607925d496b95/quartz/src/main/java/org/quartz/DailyTimeIntervalTrigger.java
//! - APScheduler의 misfire/coalesce 처리:
//!   https://github.com/agronholm/apscheduler/blob/26bff5d1001d8d259f4d7ddaad6cf055072bb257/src/apscheduler/_schedulers/async_.py

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Duration, FixedOffset, NaiveDate, TimeZone, Utc};
use serde::{Deserialize, Serialize};

use crate::config;

const JOB_STORE_VERSION: u32 = 1;

/// 코드에 등록되는 작업 식별자.
///
/// 실행 상태는 문자열 키로 저장하므로 새 작업은 엔진 enum 수정 없이
/// 고유한 ID를 선언하는 것만으로 등록할 수 있다.
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

/// 반복 계산은 Quartz `DailyTimeIntervalTrigger`의 "매일 시작점에서
/// cadence를 다시 시작"하는 규칙을 따른다.
#[allow(dead_code)] // Once/DailyAt/DailyWindow는 새 작업 등록을 위한 확장 계약이다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Trigger {
    /// 스케줄러가 현재 상태를 평가할 때마다 조건·한도·cooldown을 판단한다.
    OnTick,
    Every {
        interval_secs: u64,
    },
    Once {
        at: DateTime<Utc>,
    },
    DailyAt {
        second_of_day: u32,
    },
    DailyWindow {
        start_second: u32,
        end_second: u32,
        every_secs: u64,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MisfirePolicy {
    /// APScheduler의 coalesce/latest와 같이 놓친 실행을 현재 시점에 한 번 수행한다.
    RunOnce,
    /// 허용 지연 시간을 넘긴 실행은 건너뛰고 다음 시각을 예약한다.
    Skip,
}

#[allow(dead_code)] // CalendarDay/ConditionEpisode는 새 작업 등록을 위한 확장 계약이다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RunLimit {
    CalendarDay(u32),
    AttendanceDay(u32),
    ConditionEpisode(u32),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct JobSpec {
    pub(crate) kind: JobId,
    pub(crate) trigger: Trigger,
    pub(crate) initial_delay_secs: u64,
    pub(crate) backoff_base_secs: u64,
    pub(crate) backoff_max_secs: u64,
    pub(crate) max_failures: u32,
    pub(crate) misfire_policy: MisfirePolicy,
    pub(crate) misfire_grace_secs: u64,
    pub(crate) limits: &'static [RunLimit],
    pub(crate) cooldown_secs: Option<u64>,
    persist_runtime: bool,
}

impl JobSpec {
    pub(crate) const fn new(kind: JobId, interval_secs: u64) -> Self {
        Self {
            kind,
            trigger: Trigger::Every { interval_secs },
            initial_delay_secs: interval_secs,
            backoff_base_secs: interval_secs,
            backoff_max_secs: interval_secs,
            max_failures: u32::MAX,
            misfire_policy: MisfirePolicy::RunOnce,
            misfire_grace_secs: 60,
            limits: &[],
            cooldown_secs: None,
            persist_runtime: false,
        }
    }

    pub(crate) const fn on_tick(kind: JobId) -> Self {
        Self {
            kind,
            trigger: Trigger::OnTick,
            initial_delay_secs: 0,
            backoff_base_secs: 60,
            backoff_max_secs: 60,
            max_failures: u32::MAX,
            misfire_policy: MisfirePolicy::RunOnce,
            misfire_grace_secs: 60,
            limits: &[],
            cooldown_secs: None,
            persist_runtime: false,
        }
    }

    #[allow(dead_code)]
    pub(crate) const fn once(kind: JobId, at: DateTime<Utc>) -> Self {
        Self {
            kind,
            trigger: Trigger::Once { at },
            initial_delay_secs: 0,
            backoff_base_secs: 60,
            backoff_max_secs: 60,
            max_failures: u32::MAX,
            misfire_policy: MisfirePolicy::RunOnce,
            misfire_grace_secs: 60,
            limits: &[],
            cooldown_secs: None,
            persist_runtime: true,
        }
    }

    #[allow(dead_code)]
    pub(crate) const fn daily_at(kind: JobId, hour: u32, minute: u32) -> Self {
        assert!(hour < 24, "daily_at hour must be less than 24");
        assert!(minute < 60, "daily_at minute must be less than 60");
        Self {
            kind,
            trigger: Trigger::DailyAt {
                second_of_day: hour * 3600 + minute * 60,
            },
            initial_delay_secs: 0,
            backoff_base_secs: 60,
            backoff_max_secs: 60,
            max_failures: u32::MAX,
            misfire_policy: MisfirePolicy::RunOnce,
            misfire_grace_secs: 60,
            limits: &[],
            cooldown_secs: None,
            persist_runtime: true,
        }
    }

    #[allow(dead_code)]
    pub(crate) const fn daily_window(
        kind: JobId,
        start_hour: u32,
        start_minute: u32,
        end_hour: u32,
        end_minute: u32,
        every_secs: u64,
    ) -> Self {
        assert!(start_hour < 24, "daily_window start hour must be less than 24");
        assert!(end_hour < 24, "daily_window end hour must be less than 24");
        assert!(start_minute < 60, "daily_window start minute must be less than 60");
        assert!(end_minute < 60, "daily_window end minute must be less than 60");
        assert!(every_secs > 0, "daily_window interval must be positive");
        let start_second = start_hour * 3600 + start_minute * 60;
        let end_second = end_hour * 3600 + end_minute * 60;
        assert!(start_second <= end_second, "daily_window cannot cross midnight");
        Self {
            kind,
            trigger: Trigger::DailyWindow {
                start_second,
                end_second,
                every_secs,
            },
            initial_delay_secs: 0,
            backoff_base_secs: every_secs,
            backoff_max_secs: every_secs,
            max_failures: u32::MAX,
            misfire_policy: MisfirePolicy::RunOnce,
            misfire_grace_secs: 60,
            limits: &[],
            cooldown_secs: None,
            persist_runtime: true,
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

    #[allow(dead_code)]
    pub(crate) const fn misfire_policy(mut self, policy: MisfirePolicy, grace_secs: u64) -> Self {
        self.misfire_policy = policy;
        self.misfire_grace_secs = grace_secs;
        self
    }

    pub(crate) const fn limits(mut self, limits: &'static [RunLimit]) -> Self {
        self.limits = limits;
        self.persist_runtime = true;
        self
    }

    pub(crate) const fn cooldown_secs(mut self, seconds: u64) -> Self {
        self.cooldown_secs = Some(seconds);
        self.persist_runtime = true;
        self
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum JobActionReason {
    Initial,
    IntervalDue,
    RetryDue,
    Misfire,
    DelayedTick,
    Tick,
}

impl JobActionReason {
    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Initial => "initial",
            Self::IntervalDue => "interval due",
            Self::RetryDue => "retry due",
            Self::Misfire => "misfire",
            Self::DelayedTick => "delayed tick",
            Self::Tick => "tick",
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

    pub(crate) fn kind(self) -> JobId {
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
    Misfire,
    ConditionFalse,
    LimitReached,
    Completed,
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
pub(crate) struct JobEvaluation<'a> {
    now: DateTime<Utc>,
    local_now: DateTime<FixedOffset>,
    attendance_day: &'a str,
    condition_active: bool,
}

impl<'a> JobEvaluation<'a> {
    pub(crate) const fn new(
        now: DateTime<Utc>,
        local_now: DateTime<FixedOffset>,
        attendance_day: &'a str,
        condition_active: bool,
    ) -> Self {
        Self {
            now,
            local_now,
            attendance_day,
            condition_active,
        }
    }

    #[cfg(test)]
    pub(crate) const fn now(&self) -> DateTime<Utc> {
        self.now
    }

    fn calendar_day(&self) -> String {
        self.local_now.format("%Y-%m-%d").to_string()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default)]
pub(crate) struct JobRuntime {
    pub(crate) next_due_at: Option<DateTime<Utc>>,
    pub(crate) last_success_at: Option<DateTime<Utc>>,
    pub(crate) last_failure_at: Option<DateTime<Utc>>,
    pub(crate) consecutive_failures: u32,
    pub(crate) given_up: bool,
    pub(crate) completed: bool,
    calendar_day: Option<String>,
    calendar_runs: u32,
    attendance_day: Option<String>,
    attendance_runs: u32,
    condition_active: bool,
    condition_runs: u32,
}

impl JobRuntime {
    #[cfg(test)]
    pub(crate) fn mark_success(&mut self, spec: &JobSpec, now: DateTime<Utc>) {
        let offset = FixedOffset::east_opt(0).unwrap();
        let local_now = now.with_timezone(&offset);
        let attendance_day = local_now.format("%Y-%m-%d").to_string();
        let evaluation = JobEvaluation::new(now, local_now, &attendance_day, true);
        self.mark_success_with_context(spec, &evaluation);
    }

    pub(crate) fn mark_success_with_context(&mut self, spec: &JobSpec, evaluation: &JobEvaluation<'_>) {
        self.sync_scopes(evaluation);
        let mut count_calendar_day = false;
        let mut count_attendance_day = false;
        let mut count_condition_episode = false;
        for limit in spec.limits {
            match limit {
                RunLimit::CalendarDay(_) => count_calendar_day = true,
                RunLimit::AttendanceDay(_) => count_attendance_day = true,
                RunLimit::ConditionEpisode(_) => count_condition_episode = true,
            }
        }
        if count_calendar_day {
            self.calendar_runs = self.calendar_runs.saturating_add(1);
        }
        if count_attendance_day {
            self.attendance_runs = self.attendance_runs.saturating_add(1);
        }
        if count_condition_episode {
            self.condition_runs = self.condition_runs.saturating_add(1);
        }

        self.last_success_at = Some(evaluation.now);
        self.consecutive_failures = 0;
        self.given_up = false;
        self.advance_trigger(spec, evaluation);
    }

    pub(crate) fn mark_not_eligible_with_context(&mut self, spec: &JobSpec, evaluation: &JobEvaluation<'_>) {
        self.sync_scopes(evaluation);
        self.advance_trigger(spec, evaluation);
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

    fn sync_scopes(&mut self, evaluation: &JobEvaluation<'_>) {
        let calendar_day = evaluation.calendar_day();
        if self.calendar_day.as_deref() != Some(calendar_day.as_str()) {
            self.calendar_day = Some(calendar_day);
            self.calendar_runs = 0;
        }

        if self.attendance_day.as_deref() != Some(evaluation.attendance_day) {
            self.attendance_day = Some(evaluation.attendance_day.to_string());
            self.attendance_runs = 0;
        }

        match (self.condition_active, evaluation.condition_active) {
            (false, true) => {
                self.condition_active = true;
                self.condition_runs = 0;
            }
            (true, false) => {
                self.condition_active = false;
                self.condition_runs = 0;
            }
            _ => {}
        }
    }

    fn limit_reached(&self, limits: &[RunLimit]) -> bool {
        limits.iter().any(|limit| match *limit {
            RunLimit::CalendarDay(max) => self.calendar_runs >= max,
            RunLimit::AttendanceDay(max) => self.attendance_runs >= max,
            RunLimit::ConditionEpisode(max) => self.condition_runs >= max,
        })
    }

    fn advance_trigger(&mut self, spec: &JobSpec, evaluation: &JobEvaluation<'_>) {
        match spec.trigger {
            Trigger::OnTick => {
                self.next_due_at = None;
            }
            Trigger::Every { interval_secs } => {
                self.next_due_at = Some(add_secs(evaluation.now, interval_secs));
            }
            Trigger::Once { .. } => {
                self.completed = true;
                self.next_due_at = None;
            }
            Trigger::DailyAt { second_of_day } => {
                self.next_due_at = next_daily_at_after(evaluation.local_now, second_of_day);
            }
            Trigger::DailyWindow {
                start_second,
                end_second,
                every_secs,
            } => {
                self.next_due_at = next_daily_window_after(evaluation.local_now, start_second, end_second, every_secs);
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct JobStore {
    #[serde(default = "job_store_version")]
    version: u32,
    #[serde(default)]
    runtimes: BTreeMap<String, JobRuntime>,
    #[serde(skip)]
    dirty: bool,
}

impl Default for JobStore {
    fn default() -> Self {
        Self {
            version: JOB_STORE_VERSION,
            runtimes: BTreeMap::new(),
            dirty: false,
        }
    }
}

impl JobStore {
    #[cfg(test)]
    pub(crate) fn last_success_at(&self, kind: JobId) -> Option<DateTime<Utc>> {
        self.runtimes
            .get(kind.name())
            .and_then(|runtime| runtime.last_success_at)
    }

    #[cfg(test)]
    pub(crate) fn mark_success(&mut self, spec: &JobSpec, now: DateTime<Utc>) {
        self.runtimes
            .entry(spec.kind.name().to_string())
            .or_default()
            .mark_success(spec, now);
        self.dirty |= spec.persist_runtime;
    }

    pub(crate) fn mark_success_with_context(&mut self, spec: &JobSpec, evaluation: &JobEvaluation<'_>) {
        self.runtimes
            .entry(spec.kind.name().to_string())
            .or_default()
            .mark_success_with_context(spec, evaluation);
        self.dirty |= spec.persist_runtime;
    }

    pub(crate) fn mark_not_eligible_with_context(&mut self, spec: &JobSpec, evaluation: &JobEvaluation<'_>) {
        self.runtimes
            .entry(spec.kind.name().to_string())
            .or_default()
            .mark_not_eligible_with_context(spec, evaluation);
        self.dirty |= spec.persist_runtime;
    }

    pub(crate) fn mark_failure(&mut self, spec: &JobSpec, now: DateTime<Utc>) -> JobFailureDecision {
        let decision = self
            .runtimes
            .entry(spec.kind.name().to_string())
            .or_default()
            .mark_failure(spec, now);
        self.dirty |= spec.persist_runtime;
        decision
    }

    #[cfg(test)]
    pub(crate) fn collect_due_actions(&mut self, now: DateTime<Utc>, specs: &[JobSpec]) -> Vec<JobAction> {
        specs
            .iter()
            .filter_map(|spec| match self.decide(spec, now) {
                JobDecision::Run(action) => Some(action),
                JobDecision::Skip { .. } | JobDecision::GiveUp { .. } => None,
            })
            .collect()
    }

    #[cfg(test)]
    pub(crate) fn decide(&mut self, spec: &JobSpec, now: DateTime<Utc>) -> JobDecision {
        let offset = FixedOffset::east_opt(0).unwrap();
        let local_now = now.with_timezone(&offset);
        let attendance_day = local_now.format("%Y-%m-%d").to_string();
        let evaluation = JobEvaluation::new(now, local_now, &attendance_day, true);
        self.decide_with_context(spec, &evaluation)
    }

    pub(crate) fn decide_with_context(&mut self, spec: &JobSpec, evaluation: &JobEvaluation<'_>) -> JobDecision {
        let runtime = self.runtimes.entry(spec.kind.name().to_string()).or_default();
        let previous = runtime.clone();
        let decision = decide_job_with_context(spec, runtime, evaluation);
        self.dirty |= spec.persist_runtime && *runtime != previous;
        decision
    }

    pub(crate) fn next_due_at_for(&self, specs: &[JobSpec]) -> Option<DateTime<Utc>> {
        specs
            .iter()
            .filter_map(|spec| self.runtimes.get(spec.kind.name()))
            .filter(|runtime| !runtime.given_up && !runtime.completed)
            .filter_map(|runtime| runtime.next_due_at)
            .min()
    }

    pub(crate) fn take_dirty(&mut self) -> bool {
        std::mem::take(&mut self.dirty)
    }

    pub(crate) fn mark_dirty(&mut self) {
        self.dirty = true;
    }

    pub(crate) fn load() -> Result<Self, String> {
        let path = job_store_path().ok_or_else(|| "운영체제 설정 디렉토리를 확인할 수 없습니다.".to_string())?;
        Self::load_from(&path)
    }

    pub(crate) fn load_from(path: &Path) -> Result<Self, String> {
        let data = match fs::read_to_string(path) {
            Ok(data) => data,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Self::default()),
            Err(error) => return Err(format!("스케줄 상태 파일({}) 읽기 실패: {error}", path.display())),
        };
        let mut store: Self = serde_json::from_str(&data)
            .map_err(|error| format!("스케줄 상태 파일({}) 파싱 실패: {error}", path.display()))?;
        if store.version != JOB_STORE_VERSION {
            return Err(format!("지원하지 않는 스케줄 상태 버전입니다: {}", store.version));
        }
        store.dirty = false;
        Ok(store)
    }

    pub(crate) fn save(&self) -> Result<(), String> {
        let path = job_store_path().ok_or_else(|| "운영체제 설정 디렉토리를 확인할 수 없습니다.".to_string())?;
        self.save_to(&path)
    }

    pub(crate) fn save_to(&self, path: &Path) -> Result<(), String> {
        let parent = path
            .parent()
            .ok_or_else(|| "스케줄 상태 파일 상위 디렉토리가 없습니다.".to_string())?;
        fs::create_dir_all(parent)
            .map_err(|error| format!("스케줄 상태 디렉토리({}) 생성 실패: {error}", parent.display()))?;
        let data = serde_json::to_string_pretty(self).map_err(|error| format!("스케줄 상태 직렬화 실패: {error}"))?;
        config::write_file_atomically(path, data.as_bytes())
            .map_err(|error| format!("스케줄 상태 파일({}) 저장 실패: {error}", path.display()))
    }
}

const fn job_store_version() -> u32 {
    JOB_STORE_VERSION
}

fn job_store_path() -> Option<PathBuf> {
    config::config_path().map(|path| path.with_file_name("scheduler-state.json"))
}

#[cfg(test)]
pub(crate) fn decide_job(spec: &JobSpec, runtime: &mut JobRuntime, now: DateTime<Utc>) -> JobDecision {
    let offset = FixedOffset::east_opt(0).unwrap();
    let local_now = now.with_timezone(&offset);
    let attendance_day = local_now.format("%Y-%m-%d").to_string();
    let evaluation = JobEvaluation::new(now, local_now, &attendance_day, true);
    decide_job_with_context(spec, runtime, &evaluation)
}

pub(crate) fn decide_job_with_context(
    spec: &JobSpec,
    runtime: &mut JobRuntime,
    evaluation: &JobEvaluation<'_>,
) -> JobDecision {
    if runtime.given_up {
        return JobDecision::GiveUp { kind: spec.kind };
    }
    if runtime.completed {
        return JobDecision::Skip {
            kind: spec.kind,
            reason: JobSkipReason::Completed,
            next_due_at: None,
        };
    }

    runtime.sync_scopes(evaluation);

    if matches!(spec.trigger, Trigger::OnTick) {
        return decide_on_tick_job(spec, runtime, evaluation);
    }

    let Some(next_due_at) = runtime.next_due_at else {
        let next_due_at = initial_due_at(spec, evaluation);
        runtime.next_due_at = Some(next_due_at);
        if evaluation.now < next_due_at {
            return JobDecision::Skip {
                kind: spec.kind,
                reason: JobSkipReason::Scheduled,
                next_due_at: Some(next_due_at),
            };
        }

        return decide_due_job(spec, runtime, evaluation, true, next_due_at);
    };

    if evaluation.now < next_due_at {
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

    decide_due_job(spec, runtime, evaluation, false, next_due_at)
}

fn decide_on_tick_job(spec: &JobSpec, runtime: &mut JobRuntime, evaluation: &JobEvaluation<'_>) -> JobDecision {
    if !evaluation.condition_active {
        runtime.next_due_at = None;
        return JobDecision::Skip {
            kind: spec.kind,
            reason: JobSkipReason::ConditionFalse,
            next_due_at: None,
        };
    }

    if runtime.limit_reached(spec.limits) {
        runtime.next_due_at = None;
        return JobDecision::Skip {
            kind: spec.kind,
            reason: JobSkipReason::LimitReached,
            next_due_at: None,
        };
    }

    if let Some(retry_at) = runtime.next_due_at {
        if evaluation.now < retry_at {
            return JobDecision::Skip {
                kind: spec.kind,
                reason: JobSkipReason::BackingOff,
                next_due_at: Some(retry_at),
            };
        }
    }

    if runtime.consecutive_failures == 0 {
        if let (Some(last_success_at), Some(cooldown_secs)) = (runtime.last_success_at, spec.cooldown_secs) {
            let next_due_at = add_secs(last_success_at, cooldown_secs);
            if evaluation.now < next_due_at {
                return JobDecision::Skip {
                    kind: spec.kind,
                    reason: JobSkipReason::NotDue,
                    next_due_at: Some(next_due_at),
                };
            }
        }
    }

    let reason = if runtime.consecutive_failures > 0 {
        JobActionReason::RetryDue
    } else {
        JobActionReason::Tick
    };
    JobDecision::Run(JobAction::new(spec.kind, reason))
}

fn decide_due_job(
    spec: &JobSpec,
    runtime: &mut JobRuntime,
    evaluation: &JobEvaluation<'_>,
    initial: bool,
    next_due_at: DateTime<Utc>,
) -> JobDecision {
    let delay_secs = (evaluation.now - next_due_at).num_seconds().max(0) as u64;
    let is_misfire = runtime.consecutive_failures == 0 && delay_secs > spec.misfire_grace_secs;

    if is_misfire && spec.misfire_policy == MisfirePolicy::Skip {
        runtime.advance_trigger(spec, evaluation);
        return JobDecision::Skip {
            kind: spec.kind,
            reason: JobSkipReason::Misfire,
            next_due_at: runtime.next_due_at,
        };
    }

    if !evaluation.condition_active {
        runtime.advance_trigger(spec, evaluation);
        return JobDecision::Skip {
            kind: spec.kind,
            reason: JobSkipReason::ConditionFalse,
            next_due_at: runtime.next_due_at,
        };
    }

    if runtime.limit_reached(spec.limits) {
        runtime.advance_trigger(spec, evaluation);
        return JobDecision::Skip {
            kind: spec.kind,
            reason: JobSkipReason::LimitReached,
            next_due_at: runtime.next_due_at,
        };
    }

    let reason = if runtime.consecutive_failures > 0 {
        JobActionReason::RetryDue
    } else if is_misfire {
        JobActionReason::Misfire
    } else if initial {
        JobActionReason::Initial
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
    kind: JobId,
) -> Option<JobAction> {
    let elapsed = (now - previous_tick).num_seconds();
    let threshold = expected_interval_secs.saturating_add(grace_secs) as i64;

    (elapsed > threshold).then_some(JobAction::new(kind, JobActionReason::DelayedTick))
}

fn add_secs(now: DateTime<Utc>, seconds: u64) -> DateTime<Utc> {
    now + Duration::seconds(seconds.min(i64::MAX as u64) as i64)
}

fn initial_due_at(spec: &JobSpec, evaluation: &JobEvaluation<'_>) -> DateTime<Utc> {
    match spec.trigger {
        Trigger::OnTick => evaluation.now,
        Trigger::Every { .. } => add_secs(evaluation.now, spec.initial_delay_secs),
        Trigger::Once { at } => at,
        Trigger::DailyAt { second_of_day } => local_datetime(
            evaluation.local_now.date_naive(),
            second_of_day,
            evaluation.local_now.offset(),
        ),
        Trigger::DailyWindow {
            start_second,
            end_second,
            every_secs,
        } => latest_or_next_daily_window(evaluation.local_now, start_second, end_second, every_secs),
    }
}

fn next_daily_at_after(local_now: DateTime<FixedOffset>, second_of_day: u32) -> Option<DateTime<Utc>> {
    let today = local_datetime(local_now.date_naive(), second_of_day, local_now.offset());
    if today > local_now.with_timezone(&Utc) {
        return Some(today);
    }
    local_now
        .date_naive()
        .succ_opt()
        .map(|date| local_datetime(date, second_of_day, local_now.offset()))
}

fn latest_or_next_daily_window(
    local_now: DateTime<FixedOffset>,
    start_second: u32,
    end_second: u32,
    every_secs: u64,
) -> DateTime<Utc> {
    let start = local_datetime(local_now.date_naive(), start_second, local_now.offset());
    if local_now.with_timezone(&Utc) < start {
        return start;
    }

    let end = local_datetime(local_now.date_naive(), end_second, local_now.offset());
    let capped_now = local_now.with_timezone(&Utc).min(end);
    let elapsed = (capped_now - start).num_seconds().max(0) as u64;
    add_secs(start, (elapsed / every_secs).saturating_mul(every_secs))
}

fn next_daily_window_after(
    local_now: DateTime<FixedOffset>,
    start_second: u32,
    end_second: u32,
    every_secs: u64,
) -> Option<DateTime<Utc>> {
    let start = local_datetime(local_now.date_naive(), start_second, local_now.offset());
    let now = local_now.with_timezone(&Utc);
    if now < start {
        return Some(start);
    }

    let end = local_datetime(local_now.date_naive(), end_second, local_now.offset());
    let elapsed = (now - start).num_seconds().max(0) as u64;
    let candidate = add_secs(
        start,
        (elapsed / every_secs).saturating_add(1).saturating_mul(every_secs),
    );
    if candidate <= end {
        return Some(candidate);
    }

    local_now
        .date_naive()
        .succ_opt()
        .map(|date| local_datetime(date, start_second, local_now.offset()))
}

fn local_datetime(date: NaiveDate, second_of_day: u32, offset: &FixedOffset) -> DateTime<Utc> {
    let hour = second_of_day / 3600;
    let minute = (second_of_day % 3600) / 60;
    let second = second_of_day % 60;
    offset
        .from_local_datetime(&date.and_hms_opt(hour, minute, second).unwrap())
        .single()
        .unwrap()
        .with_timezone(&Utc)
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
    use chrono::{FixedOffset, TimeZone, Utc};
    use std::fs;

    const TEST_TASK: JobSpec = JobSpec::new(JobId::new("checker_session_refresh"), 60);
    const ONCE_PER_CALENDAR_DAY: [RunLimit; 1] = [RunLimit::CalendarDay(1)];
    const ONCE_PER_ATTENDANCE_DAY: [RunLimit; 1] = [RunLimit::AttendanceDay(1)];
    const TWICE_PER_CONDITION: [RunLimit; 1] = [RunLimit::ConditionEpisode(2)];

    fn utc(h: u32, m: u32, s: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 3, 17, h, m, s).unwrap()
    }

    fn evaluation(
        day: u32,
        hour: u32,
        minute: u32,
        second: u32,
        attendance_day: &str,
        condition_active: bool,
    ) -> JobEvaluation<'_> {
        let local_now = FixedOffset::east_opt(9 * 3600)
            .unwrap()
            .with_ymd_and_hms(2026, 3, day, hour, minute, second)
            .unwrap();
        JobEvaluation::new(
            local_now.with_timezone(&Utc),
            local_now,
            attendance_day,
            condition_active,
        )
    }

    #[test]
    fn 첫_평가는_initialize이고_due가_아니다() {
        let mut runtime = JobRuntime::default();

        let decision = decide_job(&TEST_TASK, &mut runtime, utc(9, 0, 0));

        assert_eq!(
            decision,
            JobDecision::Skip {
                kind: JobId::new("checker_session_refresh"),
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
                kind: JobId::new("checker_session_refresh"),
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
                JobId::new("checker_session_refresh"),
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
                kind: JobId::new("checker_session_refresh"),
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
                .get(JobId::new("checker_session_refresh").name())
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
        assert_eq!(actions[0].kind(), JobId::new("checker_session_refresh"));
        assert_eq!(
            store.last_success_at(JobId::new("checker_session_refresh")),
            Some(utc(9, 0, 0))
        );
    }

    #[test]
    fn job_engine은_initial_delay_due_success를_분리한다() {
        let spec = JobSpec::new(JobId::new("checker_session_refresh"), 60)
            .initial_delay_secs(60)
            .max_failures(3);
        let mut runtime = JobRuntime::default();

        assert_eq!(
            decide_job(&spec, &mut runtime, utc(9, 0, 0)),
            JobDecision::Skip {
                kind: JobId::new("checker_session_refresh"),
                reason: JobSkipReason::Scheduled,
                next_due_at: Some(utc(9, 1, 0)),
            }
        );
        assert_eq!(
            decide_job(&spec, &mut runtime, utc(9, 0, 59)),
            JobDecision::Skip {
                kind: JobId::new("checker_session_refresh"),
                reason: JobSkipReason::NotDue,
                next_due_at: Some(utc(9, 1, 0)),
            }
        );
        assert_eq!(
            decide_job(&spec, &mut runtime, utc(9, 1, 0)),
            JobDecision::Run(JobAction::new(
                JobId::new("checker_session_refresh"),
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
        let spec = JobSpec::new(JobId::new("checker_session_refresh"), 60)
            .initial_delay_secs(0)
            .backoff_secs(10, 40)
            .max_failures(3);
        let mut runtime = JobRuntime::default();

        assert_eq!(
            decide_job(&spec, &mut runtime, utc(9, 0, 0)),
            JobDecision::Run(JobAction::new(
                JobId::new("checker_session_refresh"),
                JobActionReason::Initial,
            ))
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
                kind: JobId::new("checker_session_refresh")
            }
        );
        assert_eq!(
            decide_job(&spec, &mut runtime, utc(9, 1, 0)),
            JobDecision::GiveUp {
                kind: JobId::new("checker_session_refresh")
            }
        );
    }

    #[test]
    fn delayed_tick은_복구_job_action으로_표현된다() {
        let action = delayed_tick_action(
            utc(9, 0, 0),
            60,
            utc(9, 2, 1),
            60,
            JobId::new("checker_session_refresh"),
        );

        assert_eq!(
            action,
            Some(JobAction::new(
                JobId::new("checker_session_refresh"),
                JobActionReason::DelayedTick,
            ))
        );
    }

    #[test]
    fn daily_at_run_once는_놓친_시각을_한_번만_복구한다() {
        let spec = JobSpec::daily_at(JobId::new("meals_refresh"), 9, 0).misfire_policy(MisfirePolicy::RunOnce, 60);
        let mut runtime = JobRuntime::default();
        let late = evaluation(17, 9, 30, 0, "2026-03-17", true);

        assert_eq!(
            decide_job_with_context(&spec, &mut runtime, &late),
            JobDecision::Run(JobAction::new(JobId::new("meals_refresh"), JobActionReason::Misfire))
        );

        runtime.mark_success_with_context(&spec, &late);
        assert_eq!(
            runtime.next_due_at,
            Some(evaluation(18, 9, 0, 0, "2026-03-18", true).now())
        );
    }

    #[test]
    fn once는_성공한_뒤_완료_상태를_유지한다() {
        let at = evaluation(17, 9, 0, 0, "2026-03-17", true);
        let spec = JobSpec::once(JobId::new("meals_refresh"), at.now());
        let mut runtime = JobRuntime::default();

        assert!(matches!(
            decide_job_with_context(&spec, &mut runtime, &at),
            JobDecision::Run(_)
        ));
        runtime.mark_success_with_context(&spec, &at);

        assert_eq!(
            decide_job_with_context(&spec, &mut runtime, &evaluation(18, 9, 0, 0, "2026-03-18", true),),
            JobDecision::Skip {
                kind: JobId::new("meals_refresh"),
                reason: JobSkipReason::Completed,
                next_due_at: None,
            }
        );
    }

    #[test]
    fn daily_at_skip은_놓친_시각을_건너뛴다() {
        let spec = JobSpec::daily_at(JobId::new("meals_refresh"), 9, 0).misfire_policy(MisfirePolicy::Skip, 60);
        let mut runtime = JobRuntime::default();
        let late = evaluation(17, 9, 30, 0, "2026-03-17", true);

        assert_eq!(
            decide_job_with_context(&spec, &mut runtime, &late),
            JobDecision::Skip {
                kind: JobId::new("meals_refresh"),
                reason: JobSkipReason::Misfire,
                next_due_at: Some(evaluation(18, 9, 0, 0, "2026-03-18", true).now()),
            }
        );
    }

    #[test]
    fn daily_window는_매일_시작점을_기준으로_반복한다() {
        let spec = JobSpec::daily_window(JobId::new("meals_refresh"), 10, 0, 12, 0, 20 * 60);
        let mut runtime = JobRuntime::default();
        let start = evaluation(17, 10, 0, 0, "2026-03-17", true);

        assert_eq!(
            decide_job_with_context(&spec, &mut runtime, &start),
            JobDecision::Run(JobAction::new(JobId::new("meals_refresh"), JobActionReason::Initial))
        );
        runtime.mark_success_with_context(&spec, &start);
        assert_eq!(
            runtime.next_due_at,
            Some(evaluation(17, 10, 20, 0, "2026-03-17", true).now())
        );

        assert!(matches!(
            decide_job_with_context(&spec, &mut runtime, &evaluation(17, 10, 19, 59, "2026-03-17", true),),
            JobDecision::Skip {
                reason: JobSkipReason::NotDue,
                ..
            }
        ));
        assert!(matches!(
            decide_job_with_context(&spec, &mut runtime, &evaluation(17, 10, 20, 0, "2026-03-17", true),),
            JobDecision::Run(_)
        ));

        let end = evaluation(17, 12, 0, 0, "2026-03-17", true);
        runtime.mark_success_with_context(&spec, &end);
        assert_eq!(
            runtime.next_due_at,
            Some(evaluation(18, 10, 0, 0, "2026-03-18", true).now())
        );
    }

    #[test]
    fn 출석일_실행_한도는_다음_출석일에_초기화된다() {
        let spec = JobSpec::new(JobId::new("meals_refresh"), 60)
            .initial_delay_secs(0)
            .limits(&ONCE_PER_ATTENDANCE_DAY);
        let mut runtime = JobRuntime::default();
        let first = evaluation(17, 9, 0, 0, "2026-03-17", true);

        assert!(matches!(
            decide_job_with_context(&spec, &mut runtime, &first),
            JobDecision::Run(_)
        ));
        runtime.mark_success_with_context(&spec, &first);

        assert!(matches!(
            decide_job_with_context(&spec, &mut runtime, &evaluation(17, 9, 1, 0, "2026-03-17", true),),
            JobDecision::Skip {
                reason: JobSkipReason::LimitReached,
                ..
            }
        ));
        assert!(matches!(
            decide_job_with_context(&spec, &mut runtime, &evaluation(18, 9, 0, 0, "2026-03-18", true),),
            JobDecision::Run(_)
        ));
    }

    #[test]
    fn 달력일_실행_한도는_자정에_초기화된다() {
        let spec = JobSpec::new(JobId::new("meals_refresh"), 60)
            .initial_delay_secs(0)
            .limits(&ONCE_PER_CALENDAR_DAY);
        let mut runtime = JobRuntime::default();
        let first = evaluation(17, 23, 58, 0, "2026-03-17", true);

        assert!(matches!(
            decide_job_with_context(&spec, &mut runtime, &first),
            JobDecision::Run(_)
        ));
        runtime.mark_success_with_context(&spec, &first);
        assert!(matches!(
            decide_job_with_context(&spec, &mut runtime, &evaluation(17, 23, 59, 0, "2026-03-17", true),),
            JobDecision::Skip {
                reason: JobSkipReason::LimitReached,
                ..
            }
        ));
        assert!(matches!(
            decide_job_with_context(&spec, &mut runtime, &evaluation(18, 0, 0, 0, "2026-03-17", true),),
            JobDecision::Run(_)
        ));
    }

    #[test]
    fn 조건_구간_실행_한도는_false를_거친_뒤_초기화된다() {
        let spec = JobSpec::new(JobId::new("meals_refresh"), 60)
            .initial_delay_secs(0)
            .limits(&TWICE_PER_CONDITION);
        let mut runtime = JobRuntime::default();

        for minute in [0, 1] {
            let current = evaluation(17, 10, minute, 0, "2026-03-17", true);
            assert!(matches!(
                decide_job_with_context(&spec, &mut runtime, &current),
                JobDecision::Run(_)
            ));
            runtime.mark_success_with_context(&spec, &current);
        }

        assert!(matches!(
            decide_job_with_context(&spec, &mut runtime, &evaluation(17, 10, 2, 0, "2026-03-17", true),),
            JobDecision::Skip {
                reason: JobSkipReason::LimitReached,
                ..
            }
        ));
        assert!(matches!(
            decide_job_with_context(&spec, &mut runtime, &evaluation(17, 10, 3, 0, "2026-03-17", false),),
            JobDecision::Skip {
                reason: JobSkipReason::ConditionFalse,
                ..
            }
        ));
        assert!(matches!(
            decide_job_with_context(&spec, &mut runtime, &evaluation(17, 10, 4, 0, "2026-03-17", true),),
            JobDecision::Run(_)
        ));
    }

    #[test]
    fn 실행하지_않은_job은_한도에_포함하지_않는다() {
        let spec = JobSpec::new(JobId::new("meals_refresh"), 60)
            .initial_delay_secs(0)
            .limits(&ONCE_PER_ATTENDANCE_DAY);
        let mut store = JobStore::default();
        let first = evaluation(17, 9, 0, 0, "2026-03-17", true);

        assert!(matches!(store.decide_with_context(&spec, &first), JobDecision::Run(_)));
        store.mark_not_eligible_with_context(&spec, &first);

        assert!(matches!(
            store.decide_with_context(&spec, &evaluation(17, 9, 1, 0, "2026-03-17", true),),
            JobDecision::Run(_)
        ));
    }

    #[test]
    fn job_store는_실행_상태를_json으로_복원한다() {
        let spec = JobSpec::new(JobId::new("meals_refresh"), 60)
            .initial_delay_secs(0)
            .limits(&ONCE_PER_ATTENDANCE_DAY);
        let first = evaluation(17, 9, 0, 0, "2026-03-17", true);
        let mut store = JobStore::default();
        assert!(matches!(store.decide_with_context(&spec, &first), JobDecision::Run(_)));
        store.mark_success_with_context(&spec, &first);

        let path = std::env::temp_dir().join(format!(
            "jungle-bell-scheduler-state-{}-{}.json",
            std::process::id(),
            first.now().timestamp()
        ));
        store.save_to(&path).unwrap();
        let mut restored = JobStore::load_from(&path).unwrap();
        fs::remove_file(path).unwrap();

        assert_eq!(restored.last_success_at(JobId::new("meals_refresh")), Some(first.now()));
        assert!(matches!(
            restored.decide_with_context(&spec, &evaluation(17, 9, 1, 0, "2026-03-17", true),),
            JobDecision::Skip {
                reason: JobSkipReason::LimitReached,
                ..
            }
        ));
    }

    #[test]
    fn 고빈도_interval은_영속_저장을_요청하지_않는다() {
        let mut store = JobStore::default();
        let now = utc(9, 0, 0);

        store.mark_success(&TEST_TASK, now);

        assert!(!store.take_dirty());
    }

    #[test]
    fn 선언형_job_id는_엔진_enum_수정_없이_사용할_수_있다() {
        const CUSTOM_TASK: JobId = JobId::new("test.custom-task");
        let spec = JobSpec::on_tick(CUSTOM_TASK).limits(&ONCE_PER_ATTENDANCE_DAY);
        let first = evaluation(17, 9, 0, 0, "2026-03-17", true);
        let mut store = JobStore::default();

        assert!(matches!(store.decide_with_context(&spec, &first), JobDecision::Run(_)));
        store.mark_success_with_context(&spec, &first);

        assert!(matches!(
            store.decide_with_context(&spec, &evaluation(17, 9, 1, 0, "2026-03-17", true)),
            JobDecision::Skip {
                reason: JobSkipReason::LimitReached,
                ..
            }
        ));
        assert!(matches!(
            store.decide_with_context(&spec, &evaluation(18, 9, 0, 0, "2026-03-18", true)),
            JobDecision::Run(_)
        ));
    }

    #[test]
    fn 평가형_job의_cooldown은_현재_설정값으로_즉시_재계산된다() {
        const CUSTOM_TASK: JobId = JobId::new("test.dynamic-cooldown");
        let first = evaluation(17, 9, 0, 0, "2026-03-17", true);
        let mut store = JobStore::default();
        let initial_spec = JobSpec::on_tick(CUSTOM_TASK).cooldown_secs(30 * 60);

        assert!(matches!(
            store.decide_with_context(&initial_spec, &first),
            JobDecision::Run(_)
        ));
        store.mark_success_with_context(&initial_spec, &first);

        let shortened_spec = JobSpec::on_tick(CUSTOM_TASK).cooldown_secs(60);
        assert!(matches!(
            store.decide_with_context(&shortened_spec, &evaluation(17, 9, 1, 0, "2026-03-17", true)),
            JobDecision::Run(_)
        ));
    }

    #[test]
    fn 평가형_job의_실패_재시도도_다음_deadline에_포함된다() {
        const CUSTOM_TASK: JobId = JobId::new("test.retry-deadline");
        let spec = JobSpec::on_tick(CUSTOM_TASK).backoff_secs(10, 60);
        let current = evaluation(17, 9, 0, 0, "2026-03-17", true);
        let mut store = JobStore::default();

        assert!(matches!(
            store.decide_with_context(&spec, &current),
            JobDecision::Run(_)
        ));
        assert_eq!(
            store.mark_failure(&spec, current.now()),
            JobFailureDecision::RetryAt(current.now() + Duration::seconds(10))
        );

        assert_eq!(
            store.next_due_at_for(&[spec]),
            Some(current.now() + Duration::seconds(10))
        );
    }

    #[test]
    fn 평가형_job은_조건_구간마다_n회_한도를_적용한다() {
        const CUSTOM_TASK: JobId = JobId::new("test.condition-episode");
        let spec = JobSpec::on_tick(CUSTOM_TASK).limits(&TWICE_PER_CONDITION);
        let mut store = JobStore::default();

        for minute in [0, 1] {
            let current = evaluation(17, 9, minute, 0, "2026-03-17", true);
            assert!(matches!(
                store.decide_with_context(&spec, &current),
                JobDecision::Run(_)
            ));
            store.mark_success_with_context(&spec, &current);
        }
        assert!(matches!(
            store.decide_with_context(&spec, &evaluation(17, 9, 2, 0, "2026-03-17", true)),
            JobDecision::Skip {
                reason: JobSkipReason::LimitReached,
                ..
            }
        ));

        assert!(matches!(
            store.decide_with_context(&spec, &evaluation(17, 9, 3, 0, "2026-03-17", false)),
            JobDecision::Skip {
                reason: JobSkipReason::ConditionFalse,
                ..
            }
        ));
        assert!(matches!(
            store.decide_with_context(&spec, &evaluation(17, 9, 4, 0, "2026-03-17", true)),
            JobDecision::Run(_)
        ));
    }
}
