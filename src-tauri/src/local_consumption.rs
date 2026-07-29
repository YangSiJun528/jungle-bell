//! 공통 Snapshot을 사용자 로컬 설정에 따라 대시보드와 상황 알림으로 변환한다.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use chrono::{DateTime, Datelike, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::{Emitter, Manager};
use tokio::sync::Mutex;

use crate::attendance_day;
use crate::campus::{CampusDataKind, CampusSnapshot};
use crate::config::{Config, LaundryApplianceKind, LaundryTerminalActivity, LaundryTerminalStatus, LaundryWatch};
use crate::notification_service::{NotificationAction, NotificationRequest, NotificationService};
use crate::settings_state::SettingsService;
use crate::state::{AppState, DailyPhase};

const MEAL_LUNCH_CURSOR_KEY: &str = "meals.daily.lunch";
const MEAL_DINNER_CURSOR_KEY: &str = "meals.daily.dinner";
const ATTENDANCE_START_CURSOR_KEY: &str = "attendance.start";
const ATTENDANCE_END_CURSOR_KEY: &str = "attendance.end";
const ATTENDANCE_URGENT_CURSOR_KEY: &str = "attendance.end-deadline";
const ATTENDANCE_NOTIFICATION_REPEAT_MINS: i64 = 15;
pub const LOCAL_DASHBOARD_UPDATED_EVENT: &str = "local-dashboard-updated";

#[derive(Debug, Clone, PartialEq, Eq)]
struct CursorMark {
    key: String,
    fingerprint: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct LocalNotification {
    cursor: CursorMark,
    title: String,
    body: String,
    action: NotificationAction,
    conflict_key: Option<String>,
    priority: u8,
    coalesced_cursors: Vec<CursorMark>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum LaundryTrackingPhase {
    Running,
    Paused,
    AwaitingCompletion,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LaundryReplacementCandidate {
    session_id: String,
    started_at: Option<DateTime<Utc>>,
    observed_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LaundryTrackingState {
    watch_fingerprint: String,
    phase: LaundryTrackingPhase,
    started_at: Option<DateTime<Utc>>,
    observed_at: Option<DateTime<Utc>>,
    replacement_candidate: Option<LaundryReplacementCandidate>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
struct LocalEvaluation {
    baselines: Vec<CursorMark>,
    notifications: Vec<LocalNotification>,
    finished_laundry_activity: Option<LaundryTerminalActivity>,
    laundry_tracking: Option<LaundryTrackingState>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct EventCursor {
    fingerprint: String,
    emitted_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default)]
struct EventCursorStore {
    events: BTreeMap<String, EventCursor>,
    laundry_tracking: Option<LaundryTrackingState>,
}

impl EventCursorStore {
    fn has_fingerprint(&self, mark: &CursorMark) -> bool {
        self.events
            .get(&mark.key)
            .is_some_and(|cursor| cursor.fingerprint == mark.fingerprint)
    }

    fn record_baselines(&mut self, baselines: &[CursorMark], now: DateTime<Utc>) {
        for mark in baselines {
            self.events.insert(
                mark.key.clone(),
                EventCursor {
                    fingerprint: mark.fingerprint.clone(),
                    emitted_at: now,
                },
            );
        }
    }

    fn record_notification(&mut self, notification: &LocalNotification, now: DateTime<Utc>) {
        for mark in std::iter::once(&notification.cursor).chain(notification.coalesced_cursors.iter()) {
            self.events.insert(
                mark.key.clone(),
                EventCursor {
                    fingerprint: mark.fingerprint.clone(),
                    emitted_at: now,
                },
            );
        }
    }

    fn load() -> Result<Self, String> {
        let path = event_cursor_path().ok_or_else(|| "운영체제 설정 디렉토리를 확인할 수 없습니다.".to_string())?;
        Self::load_from(&path)
    }

    fn load_from(path: &Path) -> Result<Self, String> {
        let data = match fs::read_to_string(path) {
            Ok(data) => data,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Self::default()),
            Err(error) => return Err(format!("로컬 이벤트 커서({}) 읽기 실패: {error}", path.display())),
        };
        serde_json::from_str(&data).map_err(|error| format!("로컬 이벤트 커서({}) 파싱 실패: {error}", path.display()))
    }

    fn save(&self) -> Result<(), String> {
        let path = event_cursor_path().ok_or_else(|| "운영체제 설정 디렉토리를 확인할 수 없습니다.".to_string())?;
        self.save_to(&path)
    }

    fn save_to(&self, path: &Path) -> Result<(), String> {
        let parent = path
            .parent()
            .ok_or_else(|| "로컬 이벤트 커서 상위 디렉토리가 없습니다.".to_string())?;
        fs::create_dir_all(parent)
            .map_err(|error| format!("로컬 이벤트 커서 디렉토리({}) 생성 실패: {error}", parent.display()))?;
        let data = serde_json::to_vec_pretty(self).map_err(|error| format!("로컬 이벤트 커서 직렬화 실패: {error}"))?;
        crate::config::write_file_atomically(path, &data)
            .map_err(|error| format!("로컬 이벤트 커서({}) 저장 실패: {error}", path.display()))
    }
}

fn event_cursor_path() -> Option<PathBuf> {
    crate::config::config_path().map(|path| path.with_file_name("local-event-cursors.json"))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LaundryDashboardStatus {
    Running,
    Paused,
    AwaitingCompletion,
    Completed,
    Error,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaundryDashboardCard {
    pub machine_id: String,
    pub machine_label: String,
    pub appliance: LaundryApplianceKind,
    pub session_id: String,
    pub notify_before_mins: u32,
    pub status: LaundryDashboardStatus,
    pub total_minutes: Option<u32>,
    pub estimated_finish_at: Option<String>,
    pub updated_at: Option<i64>,
    pub source_freshness: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaundryTerminalDashboardCard {
    pub id: String,
    pub machine_id: String,
    pub machine_label: String,
    pub appliance: LaundryApplianceKind,
    pub session_id: String,
    pub status: LaundryTerminalStatus,
    pub finished_at: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalDashboardSnapshot {
    pub laundry: Option<LaundryDashboardCard>,
    pub laundry_terminal_activities: Vec<LaundryTerminalDashboardCard>,
}

#[derive(Debug, Default)]
struct LocalRuntime {
    cursors: EventCursorStore,
    laundry: Option<CampusSnapshot>,
    meals: Option<CampusSnapshot>,
}

pub struct LocalConsumptionService {
    state: Arc<Mutex<AppState>>,
    notifications: Arc<NotificationService>,
    runtime: Mutex<LocalRuntime>,
}

impl LocalConsumptionService {
    pub fn new(state: Arc<Mutex<AppState>>, notifications: Arc<NotificationService>) -> Self {
        let cursors = EventCursorStore::load().unwrap_or_else(|error| {
            log::warn!("[local-consumption] {error}; 빈 이벤트 커서로 시작합니다");
            EventCursorStore::default()
        });
        Self {
            state,
            notifications,
            runtime: Mutex::new(LocalRuntime {
                cursors,
                ..LocalRuntime::default()
            }),
        }
    }

    pub async fn observe_campus(&self, app: &tauri::AppHandle, kind: CampusDataKind, snapshot: CampusSnapshot) {
        let config = self.state.lock().await.config.clone();
        let now = Utc::now();
        let mut runtime = self.runtime.lock().await;
        match kind {
            CampusDataKind::Laundry => runtime.laundry = Some(snapshot.clone()),
            CampusDataKind::Meals => runtime.meals = Some(snapshot.clone()),
        }
        let mut cursors_changed = reconcile_laundry_tracking(&mut runtime.cursors, config.laundry_watch.as_ref());
        let evaluation = match kind {
            CampusDataKind::Laundry => config
                .laundry_watch
                .as_ref()
                .map(|watch| evaluate_laundry(&snapshot.data, watch, now, &runtime.cursors))
                .unwrap_or_default(),
            CampusDataKind::Meals => {
                evaluate_meals(&snapshot.data, config.meal_subscription_enabled, now, &runtime.cursors)
            }
        };
        let finished_laundry_activity = evaluation.finished_laundry_activity.clone();
        cursors_changed |= self.apply_evaluation(app, &mut runtime, evaluation, now);
        let finished_laundry_activity = finished_laundry_activity
            .filter(|activity| finished_laundry_notification_recorded(&runtime.cursors, &activity.watch));
        if cursors_changed {
            persist_event_cursors(runtime.cursors.clone()).await;
        }
        drop(runtime);
        if let Some(finished) = finished_laundry_activity {
            self.retain_finished_laundry_activity(app, finished).await;
        }
        let config = self.state.lock().await.config.clone();
        let runtime = self.runtime.lock().await;
        let dashboard = build_dashboard_snapshot(&config, &runtime, now);
        drop(runtime);
        emit_dashboard_snapshot(app, &dashboard);
    }

    pub async fn on_scheduler_tick(
        &self,
        app: &tauri::AppHandle,
        now: DateTime<Utc>,
        phase: DailyPhase,
        remaining: Option<i64>,
    ) {
        let (config, needs_login, attendance_date) = {
            let state = self.state.lock().await;
            let kst_now = now.with_timezone(&crate::state::kst());
            (
                state.config.clone(),
                state.needs_login,
                attendance_day::effective_attendance_date(&state.config, kst_now),
            )
        };
        let attendance = AttendanceLocalState {
            phase,
            remaining,
            needs_login,
            attendance_date,
        };
        let mut runtime = self.runtime.lock().await;
        let evaluation = evaluate_attendance(&config, &attendance, now, &runtime.cursors);
        let cursors_changed = self.apply_evaluation(app, &mut runtime, evaluation, now);
        if cursors_changed {
            persist_event_cursors(runtime.cursors.clone()).await;
        }
    }

    pub async fn on_settings_changed(&self, app: &tauri::AppHandle, reset_meal_baseline: bool) {
        let config = self.state.lock().await.config.clone();
        let now = Utc::now();
        let mut runtime = self.runtime.lock().await;
        let mut cursor_changed = reconcile_laundry_tracking(&mut runtime.cursors, config.laundry_watch.as_ref());
        if reset_meal_baseline {
            for key in [MEAL_LUNCH_CURSOR_KEY, MEAL_DINNER_CURSOR_KEY] {
                cursor_changed |= runtime.cursors.events.remove(key).is_some();
            }
        }

        let mut evaluation = LocalEvaluation::default();
        if let (Some(snapshot), Some(watch)) = (&runtime.laundry, &config.laundry_watch) {
            merge_evaluation(
                &mut evaluation,
                evaluate_laundry(&snapshot.data, watch, now, &runtime.cursors),
            );
        }
        if let Some(snapshot) = &runtime.meals {
            merge_evaluation(
                &mut evaluation,
                evaluate_meals(&snapshot.data, config.meal_subscription_enabled, now, &runtime.cursors),
            );
        }
        let finished_laundry_activity = evaluation.finished_laundry_activity.clone();
        cursor_changed |= self.apply_evaluation(app, &mut runtime, evaluation, now);
        let finished_laundry_activity = finished_laundry_activity
            .filter(|activity| finished_laundry_notification_recorded(&runtime.cursors, &activity.watch));
        if cursor_changed {
            persist_event_cursors(runtime.cursors.clone()).await;
        }
        drop(runtime);
        if let Some(finished) = finished_laundry_activity {
            self.retain_finished_laundry_activity(app, finished).await;
        }
        let config = self.state.lock().await.config.clone();
        let runtime = self.runtime.lock().await;
        let dashboard = build_dashboard_snapshot(&config, &runtime, now);
        drop(runtime);
        emit_dashboard_snapshot(app, &dashboard);
    }

    pub async fn dashboard_snapshot(&self) -> LocalDashboardSnapshot {
        let config = self.state.lock().await.config.clone();
        let runtime = self.runtime.lock().await;
        build_dashboard_snapshot(&config, &runtime, Utc::now())
    }

    async fn retain_finished_laundry_activity(&self, app: &tauri::AppHandle, finished: LaundryTerminalActivity) {
        let settings = app.state::<Arc<SettingsService>>().inner().clone();
        let finished_for_update = finished.clone();
        match settings
            .update_config(app, "laundry_terminal", move |config| {
                Ok(retain_finished_laundry_activity(config, &finished_for_update))
            })
            .await
        {
            Ok(commit) if commit.changed => {
                log::info!(
                    "[local-consumption] finished laundry activity retained: machine={} session={} status={:?}",
                    finished.watch.machine_id,
                    finished.watch.session_id,
                    finished.status,
                );
                let mut runtime = self.runtime.lock().await;
                if runtime
                    .cursors
                    .laundry_tracking
                    .as_ref()
                    .is_some_and(|tracking| laundry_tracking_matches_watch(tracking, &finished.watch))
                {
                    runtime.cursors.laundry_tracking = None;
                    let cursors = runtime.cursors.clone();
                    drop(runtime);
                    persist_event_cursors(cursors).await;
                }
            }
            Ok(_) => {}
            Err(error) => {
                log::error!(
                    "[local-consumption] finished laundry activity retain failed: machine={} session={} error={error}",
                    finished.watch.machine_id,
                    finished.watch.session_id,
                );
            }
        }
    }

    fn apply_evaluation(
        &self,
        app: &tauri::AppHandle,
        runtime: &mut LocalRuntime,
        mut evaluation: LocalEvaluation,
        now: DateTime<Utc>,
    ) -> bool {
        let mut changed = !evaluation.baselines.is_empty();
        if let Some(tracking) = evaluation.laundry_tracking.take() {
            changed |= runtime.cursors.laundry_tracking.as_ref() != Some(&tracking);
            runtime.cursors.laundry_tracking = Some(tracking);
        }
        runtime.cursors.record_baselines(&evaluation.baselines, now);
        for notification in evaluation.notifications {
            let source_key = notification_source_key(&notification);
            let repeat_after_ms = notification_repeat_after_ms(&notification);
            let report = self.notifications.deliver(
                app,
                NotificationRequest {
                    key: &source_key,
                    title: &notification.title,
                    body: &notification.body,
                    action: Some(notification.action),
                    repeat_after_ms,
                },
            );

            if report.any_delivered() {
                let recorded_at = notification_recorded_at(&report, now);
                runtime.cursors.record_notification(&notification, recorded_at);
                changed = true;
            }
        }
        changed
    }
}

fn notification_recorded_at(
    report: &crate::notification_service::DeliveryReport,
    fallback: DateTime<Utc>,
) -> DateTime<Utc> {
    report
        .inbox_created_at
        .and_then(DateTime::<Utc>::from_timestamp_millis)
        .unwrap_or(fallback)
}

fn notification_source_key(notification: &LocalNotification) -> String {
    format!(
        "local:{}",
        serde_json::to_string(&(
            notification.cursor.key.as_str(),
            notification.cursor.fingerprint.as_str()
        ))
        .expect("cursor mark tuple is serializable")
    )
}

fn notification_repeat_after_ms(notification: &LocalNotification) -> Option<i64> {
    matches!(
        notification.cursor.key.as_str(),
        ATTENDANCE_START_CURSOR_KEY | ATTENDANCE_END_CURSOR_KEY
    )
    .then_some(ATTENDANCE_NOTIFICATION_REPEAT_MINS * 60 * 1_000)
}

async fn persist_event_cursors_checked(cursors: EventCursorStore) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || cursors.save())
        .await
        .map_err(|error| format!("이벤트 커서 저장 작업 실패: {error}"))?
}

async fn persist_event_cursors(cursors: EventCursorStore) {
    if let Err(error) = persist_event_cursors_checked(cursors).await {
        log::error!("[local-consumption] {error}");
    }
}

fn emit_dashboard_snapshot(app: &tauri::AppHandle, snapshot: &LocalDashboardSnapshot) {
    if let Err(error) = app.emit(LOCAL_DASHBOARD_UPDATED_EVENT, snapshot) {
        log::debug!("[local-consumption] dashboard emit skipped: {error}");
    }
}

fn merge_evaluation(target: &mut LocalEvaluation, mut source: LocalEvaluation) {
    target.baselines.append(&mut source.baselines);
    target.notifications.append(&mut source.notifications);
    if target.finished_laundry_activity.is_none() {
        target.finished_laundry_activity = source.finished_laundry_activity.take();
    }
    if target.laundry_tracking.is_none() {
        target.laundry_tracking = source.laundry_tracking.take();
    }
    target.notifications = coalesce_notifications(std::mem::take(&mut target.notifications));
}

fn laundry_watch_fingerprint(watch: &LaundryWatch) -> String {
    let appliance_key = match watch.appliance {
        LaundryApplianceKind::Washer => "washer",
        LaundryApplianceKind::Dryer => "dryer",
    };
    format!("{}:{appliance_key}:{}", watch.machine_id, watch.session_id)
}

fn laundry_tracking_matches_watch(tracking: &LaundryTrackingState, watch: &LaundryWatch) -> bool {
    tracking.watch_fingerprint == laundry_watch_fingerprint(watch)
}

fn reconcile_laundry_tracking(cursors: &mut EventCursorStore, watch: Option<&LaundryWatch>) -> bool {
    let matches = match (&cursors.laundry_tracking, watch) {
        (None, _) => true,
        (Some(tracking), Some(watch)) => laundry_tracking_matches_watch(tracking, watch),
        (Some(_), None) => false,
    };
    if matches {
        return false;
    }
    cursors.laundry_tracking = None;
    true
}

fn retain_finished_laundry_activity(config: &mut Config, finished: &LaundryTerminalActivity) -> bool {
    let Some(active_watch) = config.laundry_watch.as_ref() else {
        return false;
    };
    let finished_watch_is_active = active_watch == &finished.watch;
    if finished_watch_is_active {
        config.laundry_watch = None;
    }
    let activity_added = !config
        .laundry_terminal_activities
        .iter()
        .any(|activity| activity.id == finished.id);
    if activity_added {
        config.laundry_terminal_activities.push(finished.clone());
    }
    finished_watch_is_active || activity_added
}

fn build_dashboard_snapshot(config: &Config, runtime: &LocalRuntime, _now: DateTime<Utc>) -> LocalDashboardSnapshot {
    let mut laundry_terminal_activities = config
        .laundry_terminal_activities
        .iter()
        .map(build_laundry_terminal_dashboard_card)
        .collect::<Vec<_>>();
    laundry_terminal_activities.sort_by_key(|activity| std::cmp::Reverse(activity.finished_at));
    LocalDashboardSnapshot {
        laundry: config
            .laundry_watch
            .as_ref()
            .map(|watch| build_laundry_dashboard_card(watch, runtime)),
        laundry_terminal_activities,
    }
}

fn build_laundry_terminal_dashboard_card(activity: &LaundryTerminalActivity) -> LaundryTerminalDashboardCard {
    LaundryTerminalDashboardCard {
        id: activity.id.clone(),
        machine_id: activity.watch.machine_id.clone(),
        machine_label: laundry_machine_name(&activity.watch.machine_id),
        appliance: activity.watch.appliance,
        session_id: activity.watch.session_id.clone(),
        status: activity.status,
        finished_at: activity.finished_at,
    }
}

fn finished_laundry_activity(
    watch: &LaundryWatch,
    status: LaundryTerminalStatus,
    now: DateTime<Utc>,
) -> LaundryTerminalActivity {
    let identity = serde_json::to_vec(&(watch.machine_id.as_str(), watch.appliance, watch.session_id.as_str()))
        .expect("laundry activity identity is serializable");
    let activity_hash = Sha256::digest(identity);
    let activity_id = activity_hash
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    LaundryTerminalActivity {
        id: format!("laundry-{activity_id}"),
        watch: watch.clone(),
        status,
        finished_at: now.timestamp_millis(),
    }
}

fn laundry_completion_observed(
    data: &Value,
    watch: &LaundryWatch,
    appliance_key: &str,
    appliance: Option<&Value>,
) -> bool {
    let current_matches = appliance
        .and_then(|appliance| appliance.get("sessionId"))
        .and_then(Value::as_str)
        == Some(watch.session_id.as_str());
    let current_completed = current_matches
        && appliance.is_some_and(|appliance| {
            appliance.get("operationalStatus").and_then(Value::as_str) == Some("COMPLETED")
                || appliance
                    .get("projection")
                    .and_then(|projection| projection.get("status"))
                    .and_then(Value::as_str)
                    == Some("CONFIRMED_COMPLETED")
        });
    let completed_event = data.get("events").and_then(Value::as_array).is_some_and(|events| {
        events.iter().any(|event| {
            let is_watched_session = event.get("machineId").and_then(Value::as_str) == Some(watch.machine_id.as_str())
                && event.get("appliance").and_then(Value::as_str) == Some(appliance_key)
                && event.get("sessionId").and_then(Value::as_str) == Some(watch.session_id.as_str());
            let event_type = event.get("type").and_then(Value::as_str);
            let ended_before_power_off = event_type == Some("STATE_CHANGED")
                && event.get("previousState").and_then(Value::as_str) == Some("END")
                && matches!(
                    event.get("currentState").and_then(Value::as_str),
                    Some("POWER_OFF" | "INITIAL")
                );
            is_watched_session && (event_type == Some("COMPLETED") || ended_before_power_off)
        })
    });
    current_completed || completed_event
}

fn build_laundry_dashboard_card(watch: &LaundryWatch, runtime: &LocalRuntime) -> LaundryDashboardCard {
    let appliance_key = match watch.appliance {
        LaundryApplianceKind::Washer => "washer",
        LaundryApplianceKind::Dryer => "dryer",
    };
    let snapshot = runtime.laundry.as_ref();
    let data = snapshot.map(|snapshot| &snapshot.data);
    let appliance = data
        .and_then(|data| data.get("machines"))
        .and_then(Value::as_array)
        .and_then(|machines| {
            machines
                .iter()
                .find(|machine| machine.get("id").and_then(Value::as_str) == Some(watch.machine_id.as_str()))
        })
        .and_then(|machine| machine.get(appliance_key))
        .filter(|appliance| appliance.is_object());
    let current_matches = appliance
        .and_then(|appliance| appliance.get("sessionId"))
        .and_then(Value::as_str)
        == Some(watch.session_id.as_str());
    let completion_mark = laundry_completion_mark(watch);
    let completed = runtime.cursors.has_fingerprint(&completion_mark)
        || data.is_some_and(|data| laundry_completion_observed(data, watch, appliance_key, appliance));

    let status = if completed {
        LaundryDashboardStatus::Completed
    } else if !current_matches {
        LaundryDashboardStatus::Unavailable
    } else {
        let projection_status = appliance
            .and_then(|appliance| appliance.get("projection"))
            .and_then(|projection| projection.get("status"))
            .and_then(Value::as_str);
        let operational_status = appliance
            .and_then(|appliance| appliance.get("operationalStatus"))
            .and_then(Value::as_str);
        match projection_status.or(operational_status) {
            Some("ESTIMATED_RUNNING" | "RUNNING") => LaundryDashboardStatus::Running,
            Some("PAUSED") => LaundryDashboardStatus::Paused,
            Some("AWAITING_COMPLETION_CONFIRMATION") => LaundryDashboardStatus::AwaitingCompletion,
            Some("CONFIRMED_COMPLETED" | "COMPLETED") => LaundryDashboardStatus::Completed,
            Some("ERROR") => LaundryDashboardStatus::Error,
            _ => LaundryDashboardStatus::Unavailable,
        }
    };

    LaundryDashboardCard {
        machine_id: watch.machine_id.clone(),
        machine_label: laundry_machine_name(&watch.machine_id),
        appliance: watch.appliance,
        session_id: watch.session_id.clone(),
        notify_before_mins: watch.notify_before_mins,
        status,
        total_minutes: current_matches
            .then(|| {
                appliance
                    .and_then(|appliance| appliance.get("totalMinutes"))
                    .and_then(Value::as_u64)
                    .and_then(|minutes| u32::try_from(minutes).ok())
            })
            .flatten(),
        estimated_finish_at: current_matches
            .then(|| {
                appliance
                    .and_then(|appliance| appliance.get("estimatedFinishAt"))
                    .and_then(Value::as_str)
            })
            .flatten()
            .map(str::to_owned),
        updated_at: snapshot.map(|snapshot| snapshot.saved_at),
        source_freshness: data
            .and_then(|data| data.get("quality"))
            .and_then(|quality| quality.get("sourceFreshness"))
            .and_then(Value::as_str)
            .map(str::to_owned),
    }
}

#[derive(Debug, Clone)]
struct AttendanceLocalState {
    phase: DailyPhase,
    remaining: Option<i64>,
    needs_login: bool,
    attendance_date: String,
}

fn parse_laundry_timestamp(value: Option<&Value>) -> Option<DateTime<Utc>> {
    value
        .and_then(Value::as_str)
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
        .map(|value| value.with_timezone(&Utc))
}

fn laundry_observed_at(data: &Value, appliance: Option<&Value>) -> Option<DateTime<Utc>> {
    let appliance_observed = parse_laundry_timestamp(appliance.and_then(|appliance| appliance.get("observedAt")));
    let source_checked = parse_laundry_timestamp(data.get("quality").and_then(|quality| quality.get("lastCheckedAt")));
    match (appliance_observed, source_checked) {
        (Some(appliance), Some(source)) => Some(appliance.max(source)),
        (Some(appliance), None) => Some(appliance),
        (None, Some(source)) => Some(source),
        (None, None) => None,
    }
}

fn laundry_started_at(appliance: Option<&Value>) -> Option<DateTime<Utc>> {
    parse_laundry_timestamp(appliance.and_then(|appliance| appliance.get("startedAt")))
}

fn laundry_latest_tracking_observation(tracking: &LaundryTrackingState) -> Option<DateTime<Utc>> {
    match (
        tracking.observed_at,
        tracking
            .replacement_candidate
            .as_ref()
            .map(|candidate| candidate.observed_at),
    ) {
        (Some(current), Some(replacement)) => Some(current.max(replacement)),
        (Some(current), None) => Some(current),
        (None, Some(replacement)) => Some(replacement),
        (None, None) => None,
    }
}

fn laundry_is_actively_running(operational_status: &str, projection_status: &str) -> bool {
    if matches!(operational_status, "SCHEDULED" | "IDLE" | "COMPLETED" | "ERROR") {
        return false;
    }
    matches!(operational_status, "RUNNING" | "PAUSED")
        || matches!(
            projection_status,
            "OBSERVED" | "ESTIMATED_RUNNING" | "AWAITING_COMPLETION_CONFIRMATION" | "PAUSED"
        )
}

fn laundry_tracking_phase(operational_status: &str, projection_status: &str) -> LaundryTrackingPhase {
    if projection_status == "AWAITING_COMPLETION_CONFIRMATION" {
        LaundryTrackingPhase::AwaitingCompletion
    } else if operational_status == "PAUSED" || projection_status == "PAUSED" {
        LaundryTrackingPhase::Paused
    } else if laundry_is_actively_running(operational_status, projection_status) {
        LaundryTrackingPhase::Running
    } else {
        LaundryTrackingPhase::Unknown
    }
}

fn evaluate_laundry(
    data: &Value,
    watch: &LaundryWatch,
    now: DateTime<Utc>,
    cursors: &EventCursorStore,
) -> LocalEvaluation {
    let appliance_key = match watch.appliance {
        LaundryApplianceKind::Washer => "washer",
        LaundryApplianceKind::Dryer => "dryer",
    };
    let appliance_label = match watch.appliance {
        LaundryApplianceKind::Washer => "세탁",
        LaundryApplianceKind::Dryer => "건조",
    };
    let appliance_device_label = match watch.appliance {
        LaundryApplianceKind::Washer => "세탁기",
        LaundryApplianceKind::Dryer => "건조기",
    };
    let machine_label = data
        .get("machines")
        .and_then(Value::as_array)
        .and_then(|machines| {
            machines
                .iter()
                .find(|machine| machine.get("id").and_then(Value::as_str) == Some(watch.machine_id.as_str()))
        })
        .and_then(|machine| machine.get(appliance_key))
        .filter(|appliance| appliance.is_object());

    let current_matches = machine_label
        .and_then(|appliance| appliance.get("sessionId"))
        .and_then(Value::as_str)
        == Some(watch.session_id.as_str());
    let completed = laundry_completion_observed(data, watch, appliance_key, machine_label);
    let operational_status = machine_label
        .and_then(|appliance| appliance.get("operationalStatus"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let projection_status = machine_label
        .and_then(|appliance| appliance.get("projection"))
        .and_then(|projection| projection.get("status"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let started_at = laundry_started_at(machine_label);
    let observed_at = laundry_observed_at(data, machine_label);
    let tracking = cursors
        .laundry_tracking
        .as_ref()
        .filter(|tracking| laundry_tracking_matches_watch(tracking, watch));
    let same_session_restarted = current_matches
        && started_at.is_some_and(|started_at| {
            tracking
                .and_then(|tracking| tracking.started_at)
                .is_some_and(|tracked_start| started_at > tracked_start)
        });
    let stale_observation = observed_at.is_some_and(|observed_at| {
        tracking
            .and_then(laundry_latest_tracking_observation)
            .is_some_and(|latest| observed_at < latest)
    });
    let needs_check = !completed
        && current_matches
        && cursors.has_fingerprint(&laundry_before_mark(watch))
        && machine_label.is_some_and(|appliance| {
            appliance.get("operationalStatus").and_then(Value::as_str) == Some("IDLE")
                || appliance
                    .get("projection")
                    .and_then(|projection| projection.get("status"))
                    .and_then(Value::as_str)
                    == Some("IDLE")
        });

    let mut evaluation = LocalEvaluation::default();
    let session_conflict = Some(format!(
        "laundry:{}:{}:{}",
        watch.machine_id, appliance_key, watch.session_id
    ));
    if completed {
        let mark = laundry_completion_mark(watch);
        evaluation.finished_laundry_activity =
            Some(finished_laundry_activity(watch, LaundryTerminalStatus::Completed, now));
        if !cursors.has_fingerprint(&mark) {
            evaluation.notifications.push(LocalNotification {
                cursor: mark,
                title: format!("{appliance_label} 완료"),
                body: format!(
                    "{} {appliance_device_label}가 끝났습니다. 세탁물을 꺼내 주세요.",
                    laundry_machine_name(&watch.machine_id)
                ),
                action: NotificationAction::Laundry,
                conflict_key: session_conflict,
                priority: 80,
                coalesced_cursors: Vec::new(),
            });
        }
        return evaluation;
    }
    if !current_matches || same_session_restarted {
        if stale_observation {
            return evaluation;
        }

        let replacement_session_id = machine_label
            .and_then(|appliance| appliance.get("sessionId"))
            .and_then(Value::as_str)
            .filter(|session_id| !session_id.is_empty());
        let Some(replacement_session_id) = replacement_session_id else {
            if let Some(mut tracking) = tracking.cloned() {
                if tracking.replacement_candidate.take().is_some() {
                    evaluation.laundry_tracking = Some(tracking);
                }
            }
            return evaluation;
        };
        let replacement_is_active = laundry_is_actively_running(operational_status, projection_status);
        let Some(observed_at) = observed_at else {
            return evaluation;
        };
        let mut next_tracking = tracking.cloned().unwrap_or_else(|| LaundryTrackingState {
            watch_fingerprint: laundry_watch_fingerprint(watch),
            phase: LaundryTrackingPhase::Unknown,
            started_at: None,
            observed_at: None,
            replacement_candidate: None,
        });
        let replacement_confirmed = next_tracking.replacement_candidate.as_ref().is_some_and(|candidate| {
            candidate.session_id == replacement_session_id
                && candidate.started_at == started_at
                && observed_at > candidate.observed_at
        });

        if !replacement_confirmed {
            let candidate_changed = next_tracking.replacement_candidate.as_ref().is_none_or(|candidate| {
                candidate.session_id != replacement_session_id || candidate.started_at != started_at
            });
            if candidate_changed {
                next_tracking.replacement_candidate = Some(LaundryReplacementCandidate {
                    session_id: replacement_session_id.to_string(),
                    started_at,
                    observed_at,
                });
                evaluation.laundry_tracking = Some(next_tracking);
            }
            return evaluation;
        }

        let (mark, title, body, terminal_status) = if next_tracking.phase == LaundryTrackingPhase::AwaitingCompletion {
            (
                laundry_completion_mark(watch),
                format!("{appliance_label} 완료"),
                format!(
                    "{} {appliance_device_label}가 끝났습니다. 세탁물을 꺼내 주세요.",
                    laundry_machine_name(&watch.machine_id)
                ),
                LaundryTerminalStatus::Completed,
            )
        } else if replacement_is_active {
            (
                laundry_replacement_mark(watch),
                format!("새 {appliance_label} 시작 감지"),
                format!(
                    "{} {appliance_device_label}에서 새 작업이 시작되어 기존 추적을 종료합니다.",
                    laundry_machine_name(&watch.machine_id)
                ),
                LaundryTerminalStatus::Replaced,
            )
        } else {
            (
                laundry_replacement_mark(watch),
                format!("{appliance_label} 추적 종료"),
                format!(
                    "{} {appliance_device_label}의 선택한 작업이 끝나 기존 추적을 종료합니다.",
                    laundry_machine_name(&watch.machine_id)
                ),
                LaundryTerminalStatus::Replaced,
            )
        };
        evaluation.finished_laundry_activity = Some(finished_laundry_activity(watch, terminal_status, now));
        if !cursors.has_fingerprint(&mark) {
            evaluation.notifications.push(LocalNotification {
                cursor: mark,
                title,
                body,
                action: NotificationAction::Laundry,
                conflict_key: session_conflict,
                priority: 80,
                coalesced_cursors: Vec::new(),
            });
        }
        return evaluation;
    }
    if stale_observation {
        return evaluation;
    }

    evaluation.laundry_tracking = Some(LaundryTrackingState {
        watch_fingerprint: laundry_watch_fingerprint(watch),
        phase: laundry_tracking_phase(operational_status, projection_status),
        started_at: started_at.or_else(|| tracking.and_then(|tracking| tracking.started_at)),
        observed_at: observed_at.or_else(|| tracking.and_then(|tracking| tracking.observed_at)),
        replacement_candidate: None,
    });
    if needs_check {
        let mark = laundry_needs_check_mark(watch);
        evaluation.finished_laundry_activity =
            Some(finished_laundry_activity(watch, LaundryTerminalStatus::NeedsCheck, now));
        if !cursors.has_fingerprint(&mark) {
            evaluation.notifications.push(LocalNotification {
                cursor: mark,
                title: format!("{appliance_label} 상태 확인"),
                body: format!(
                    "{} {appliance_device_label}가 끝났거나 중단됐습니다. 상태를 확인해 주세요.",
                    laundry_machine_name(&watch.machine_id)
                ),
                action: NotificationAction::Laundry,
                conflict_key: session_conflict,
                priority: 80,
                coalesced_cursors: Vec::new(),
            });
        }
        return evaluation;
    }
    let Some(appliance) = machine_label else {
        return evaluation;
    };
    let attention = if operational_status == "ERROR" || projection_status == "ERROR" {
        Some((
            "error",
            format!("!!! {appliance_device_label} 오류"),
            format!(
                "{} {appliance_device_label} 상태를 확인해 주세요.",
                laundry_machine_name(&watch.machine_id)
            ),
            90,
        ))
    } else if projection_status == "AWAITING_COMPLETION_CONFIRMATION" {
        Some((
            "awaiting-completion",
            format!("{appliance_label} 종료 확인 중"),
            format!(
                "{} {appliance_device_label}의 종료 여부를 확인하고 있습니다.",
                laundry_machine_name(&watch.machine_id)
            ),
            75,
        ))
    } else if operational_status == "PAUSED" || projection_status == "PAUSED" {
        Some((
            "paused",
            format!("{appliance_label} 일시 정지"),
            format!(
                "{} {appliance_device_label}가 일시 정지됐습니다.",
                laundry_machine_name(&watch.machine_id)
            ),
            70,
        ))
    } else {
        None
    };
    if let Some((attention_kind, title, body, priority)) = attention {
        let mark = laundry_attention_mark(watch, attention_kind);
        if attention_kind == "error" {
            evaluation.finished_laundry_activity =
                Some(finished_laundry_activity(watch, LaundryTerminalStatus::Error, now));
        }
        if !cursors.has_fingerprint(&mark) {
            evaluation.notifications.push(LocalNotification {
                cursor: mark,
                title,
                body,
                action: NotificationAction::Laundry,
                conflict_key: session_conflict,
                priority,
                coalesced_cursors: Vec::new(),
            });
        }
        return evaluation;
    }
    let active = matches!(operational_status, "RUNNING" | "PAUSED")
        || matches!(
            projection_status,
            "ESTIMATED_RUNNING" | "AWAITING_COMPLETION_CONFIRMATION" | "PAUSED"
        );
    if !active {
        return evaluation;
    }

    let remaining_seconds = appliance
        .get("estimatedFinishAt")
        .and_then(Value::as_str)
        .and_then(|finish_at| DateTime::parse_from_rfc3339(finish_at).ok())
        .map(|finish_at| (finish_at.with_timezone(&Utc) - now).num_seconds());
    let threshold_seconds = i64::from(watch.notify_before_mins) * 60;
    if !matches!(remaining_seconds, Some(1..=i64::MAX))
        || remaining_seconds.is_some_and(|remaining| remaining > threshold_seconds)
    {
        return evaluation;
    }

    let mark = laundry_before_mark(watch);
    if !cursors.has_fingerprint(&mark) {
        evaluation.notifications.push(LocalNotification {
            cursor: mark,
            title: format!("{appliance_label} 종료 {}분 전", watch.notify_before_mins),
            body: format!(
                "{} {appliance_device_label}가 곧 끝납니다.",
                laundry_machine_name(&watch.machine_id)
            ),
            action: NotificationAction::Laundry,
            conflict_key: session_conflict,
            priority: 60,
            coalesced_cursors: Vec::new(),
        });
    }
    evaluation
}

fn laundry_completion_mark(watch: &LaundryWatch) -> CursorMark {
    let appliance_key = match watch.appliance {
        LaundryApplianceKind::Washer => "washer",
        LaundryApplianceKind::Dryer => "dryer",
    };
    CursorMark {
        key: format!("laundry.{appliance_key}.completed"),
        fingerprint: format!("{}:{}", watch.machine_id, watch.session_id),
    }
}

fn laundry_before_mark(watch: &LaundryWatch) -> CursorMark {
    let appliance_key = match watch.appliance {
        LaundryApplianceKind::Washer => "washer",
        LaundryApplianceKind::Dryer => "dryer",
    };
    CursorMark {
        key: format!("laundry.{appliance_key}.before"),
        fingerprint: format!("{}:{}:{}", watch.machine_id, watch.session_id, watch.notify_before_mins),
    }
}

fn laundry_needs_check_mark(watch: &LaundryWatch) -> CursorMark {
    let appliance_key = match watch.appliance {
        LaundryApplianceKind::Washer => "washer",
        LaundryApplianceKind::Dryer => "dryer",
    };
    CursorMark {
        key: format!("laundry.{appliance_key}.needs-check"),
        fingerprint: format!("{}:{}", watch.machine_id, watch.session_id),
    }
}

fn laundry_replacement_mark(watch: &LaundryWatch) -> CursorMark {
    let appliance_key = match watch.appliance {
        LaundryApplianceKind::Washer => "washer",
        LaundryApplianceKind::Dryer => "dryer",
    };
    CursorMark {
        key: format!("laundry.{appliance_key}.replaced"),
        fingerprint: format!("{}:{}", watch.machine_id, watch.session_id),
    }
}

fn laundry_attention_mark(watch: &LaundryWatch, attention_kind: &str) -> CursorMark {
    let appliance_key = match watch.appliance {
        LaundryApplianceKind::Washer => "washer",
        LaundryApplianceKind::Dryer => "dryer",
    };
    CursorMark {
        key: format!("laundry.{appliance_key}.{attention_kind}"),
        fingerprint: format!("{}:{}", watch.machine_id, watch.session_id),
    }
}

fn finished_laundry_notification_recorded(cursors: &EventCursorStore, watch: &LaundryWatch) -> bool {
    cursors.has_fingerprint(&laundry_completion_mark(watch))
        || cursors.has_fingerprint(&laundry_replacement_mark(watch))
        || cursors.has_fingerprint(&laundry_needs_check_mark(watch))
        || cursors.has_fingerprint(&laundry_attention_mark(watch, "error"))
}

fn laundry_machine_name(machine_id: &str) -> String {
    let suffix = machine_id
        .chars()
        .rev()
        .take_while(char::is_ascii_digit)
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>();
    if suffix.is_empty() {
        machine_id.to_string()
    } else {
        format!("{suffix}번")
    }
}

fn evaluate_meals(data: &Value, enabled: bool, now: DateTime<Utc>, cursors: &EventCursorStore) -> LocalEvaluation {
    if !enabled {
        return LocalEvaluation::default();
    }
    let Some(meals) = data.get("data") else {
        return LocalEvaluation::default();
    };
    let mut evaluation = LocalEvaluation::default();

    if let Some(daily_menus) = meals.get("dailyMenus").and_then(Value::as_array) {
        let kst_now = now.with_timezone(&crate::state::kst());
        let date_key = kst_now.format("%Y-%m-%d").to_string();
        for (period_label, cursor_key) in [("중식", MEAL_LUNCH_CURSOR_KEY), ("석식", MEAL_DINNER_CURSOR_KEY)] {
            let post = daily_menus.iter().find(|post| {
                meal_post_is_today(post, kst_now)
                    && post
                        .get("title")
                        .and_then(Value::as_str)
                        .is_some_and(|title| title.contains(period_label))
            });
            let content = post
                .and_then(|post| post.get("contentSha").or_else(|| post.get("id")))
                .and_then(Value::as_str)
                .unwrap_or("none");
            let mark = CursorMark {
                key: cursor_key.into(),
                fingerprint: format!("{date_key}:{content}"),
            };
            if cursors.has_fingerprint(&mark) {
                continue;
            }
            if !cursors.events.contains_key(cursor_key) || post.is_none() {
                evaluation.baselines.push(mark);
                continue;
            }
            let post = post.expect("a missing meal post is handled as a baseline");
            let title = format!("오늘 {period_label}이 올라왔어요");
            let preview = meal_alert_preview(post);
            evaluation.notifications.push(LocalNotification {
                cursor: mark,
                title,
                body: preview,
                action: NotificationAction::Meals,
                conflict_key: None,
                priority: 30,
                coalesced_cursors: Vec::new(),
            });
        }
    }

    evaluation.notifications = coalesce_notifications(evaluation.notifications);
    evaluation
}

fn meal_alert_preview(post: &Value) -> String {
    let value = post
        .get("text")
        .and_then(Value::as_str)
        .filter(|text| !text.trim().is_empty())
        .or_else(|| post.get("title").and_then(Value::as_str))
        .unwrap_or("메뉴 내용을 확인해 주세요");
    let normalized = value.split_whitespace().collect::<Vec<_>>().join(" · ");
    let mut preview = normalized.chars().take(120).collect::<String>();
    if normalized.chars().count() > 120 {
        preview.push('…');
    }
    preview
}

fn meal_post_is_today(post: &Value, kst_now: DateTime<chrono::FixedOffset>) -> bool {
    let title_date = format!("{}월 {}일", kst_now.month(), kst_now.day());
    if post
        .get("title")
        .and_then(Value::as_str)
        .is_some_and(|title| title.replace(' ', "").contains(&title_date.replace(' ', "")))
    {
        return true;
    }

    post.get("publishedAt")
        .or_else(|| post.get("firstSeenAt"))
        .and_then(Value::as_str)
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
        .is_some_and(|published| published.with_timezone(&crate::state::kst()).date_naive() == kst_now.date_naive())
}

fn evaluate_attendance(
    config: &Config,
    state: &AttendanceLocalState,
    now: DateTime<Utc>,
    cursors: &EventCursorStore,
) -> LocalEvaluation {
    let decision = crate::attendance::notification_decision(
        config,
        state.phase,
        state.remaining,
        state.needs_login,
        now.with_timezone(&crate::state::kst()),
    );
    if !decision.send {
        return LocalEvaluation::default();
    }

    let mut candidates = Vec::new();
    let regular_cursor_key = match state.phase {
        DailyPhase::NeedStart | DailyPhase::StartOverdue => Some(ATTENDANCE_START_CURSOR_KEY),
        DailyPhase::NeedEnd => Some(ATTENDANCE_END_CURSOR_KEY),
        _ => None,
    };
    if let Some(cursor_key) = regular_cursor_key {
        let mark = CursorMark {
            key: cursor_key.into(),
            fingerprint: state.attendance_date.clone(),
        };
        let cooldown_elapsed = cursors.events.get(cursor_key).is_none_or(|cursor| {
            cursor.fingerprint != mark.fingerprint
                || now.signed_duration_since(cursor.emitted_at)
                    >= Duration::minutes(ATTENDANCE_NOTIFICATION_REPEAT_MINS)
        });
        if cooldown_elapsed {
            let (title, body) = decision
                .message
                .clone()
                .unwrap_or_else(|| crate::attendance::notification_message(state.phase, state.remaining));
            candidates.push(LocalNotification {
                cursor: mark,
                title: title.into(),
                body,
                action: NotificationAction::Attendance,
                conflict_key: Some("attendance-notification".into()),
                priority: 10,
                coalesced_cursors: Vec::new(),
            });
        }
    }

    if state.phase == DailyPhase::NeedEnd && matches!(state.remaining, Some(1..=300)) {
        let mark = CursorMark {
            key: ATTENDANCE_URGENT_CURSOR_KEY.into(),
            fingerprint: state.attendance_date.clone(),
        };
        if !cursors.has_fingerprint(&mark) {
            let (_, body) = crate::attendance::notification_message(state.phase, state.remaining);
            candidates.push(LocalNotification {
                cursor: mark,
                title: "!!! 퇴근 출석 마감 임박".into(),
                body,
                action: NotificationAction::Attendance,
                conflict_key: Some("attendance-notification".into()),
                priority: 100,
                coalesced_cursors: Vec::new(),
            });
        }
    }

    LocalEvaluation {
        baselines: Vec::new(),
        notifications: coalesce_notifications(candidates),
        finished_laundry_activity: None,
        laundry_tracking: None,
    }
}

fn coalesce_notifications(mut candidates: Vec<LocalNotification>) -> Vec<LocalNotification> {
    candidates.sort_by_key(|notification| std::cmp::Reverse(notification.priority));
    let mut selected: Vec<LocalNotification> = Vec::new();
    for candidate in candidates {
        let Some(conflict_key) = candidate.conflict_key.as_deref() else {
            selected.push(candidate);
            continue;
        };
        if let Some(winner) = selected
            .iter_mut()
            .find(|selected| selected.conflict_key.as_deref() == Some(conflict_key))
        {
            winner.coalesced_cursors.push(candidate.cursor);
            winner.coalesced_cursors.extend(candidate.coalesced_cursors);
        } else {
            selected.push(candidate);
        }
    }
    selected
}

#[cfg(test)]
mod tests {
    use std::fs;

    use chrono::{FixedOffset, TimeZone};

    use crate::config::LaundryApplianceKind;

    use super::*;

    fn utc(hour: u32, minute: u32, second: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 7, 27, hour, minute, second).unwrap()
    }

    fn watch(notify_before_mins: u32) -> LaundryWatch {
        LaundryWatch {
            machine_id: "tower6".into(),
            appliance: LaundryApplianceKind::Washer,
            session_id: "session-1".into(),
            notify_before_mins,
        }
    }

    fn finished_watch(evaluation: &LocalEvaluation) -> Option<LaundryWatch> {
        evaluation
            .finished_laundry_activity
            .as_ref()
            .map(|activity| activity.watch.clone())
    }

    fn finished_status(evaluation: &LocalEvaluation) -> Option<LaundryTerminalStatus> {
        evaluation
            .finished_laundry_activity
            .as_ref()
            .map(|activity| activity.status)
    }

    fn laundry(status: &str, projection: &str, finish_at: &str, session_id: &str) -> Value {
        serde_json::json!({
            "schemaVersion": 1,
            "machines": [{
                "id": "tower6",
                "washer": {
                    "machineId": "tower6",
                    "appliance": "washer",
                    "operationalStatus": status,
                    "projection": { "status": projection },
                    "totalMinutes": 60,
                    "estimatedFinishAt": finish_at,
                    "sessionId": session_id
                },
                "dryer": null
            }],
            "events": [],
            "quality": {}
        })
    }

    fn dryer_watch(notify_before_mins: u32) -> LaundryWatch {
        LaundryWatch {
            appliance: LaundryApplianceKind::Dryer,
            ..watch(notify_before_mins)
        }
    }

    fn dryer(status: &str, projection: &str, finish_at: &str, session_id: &str) -> Value {
        serde_json::json!({
            "schemaVersion": 1,
            "machines": [{
                "id": "tower6",
                "washer": null,
                "dryer": {
                    "machineId": "tower6",
                    "appliance": "dryer",
                    "operationalStatus": status,
                    "projection": { "status": projection },
                    "totalMinutes": 60,
                    "estimatedFinishAt": finish_at,
                    "sessionId": session_id
                }
            }],
            "events": [],
            "quality": {}
        })
    }

    fn observed_at(mut data: Value, appliance: LaundryApplianceKind, value: &str) -> Value {
        let appliance_key = match appliance {
            LaundryApplianceKind::Washer => "washer",
            LaundryApplianceKind::Dryer => "dryer",
        };
        data["machines"][0][appliance_key]["observedAt"] = Value::String(value.into());
        data
    }

    fn started_at(mut data: Value, appliance: LaundryApplianceKind, value: &str) -> Value {
        let appliance_key = match appliance {
            LaundryApplianceKind::Washer => "washer",
            LaundryApplianceKind::Dryer => "dryer",
        };
        data["machines"][0][appliance_key]["startedAt"] = Value::String(value.into());
        data
    }

    fn checked_at(mut data: Value, value: &str) -> Value {
        data["quality"]["lastCheckedAt"] = Value::String(value.into());
        data
    }

    fn apply_laundry_tracking(cursors: &mut EventCursorStore, evaluation: &LocalEvaluation) {
        if let Some(tracking) = &evaluation.laundry_tracking {
            cursors.laundry_tracking = Some(tracking.clone());
        }
    }

    #[test]
    fn 선택한_세탁_세션은_종료_n분전에_한번만_알린다() {
        let now = utc(9, 0, 0);
        let data = laundry("RUNNING", "ESTIMATED_RUNNING", "2026-07-27T09:05:00Z", "session-1");
        let mut cursors = EventCursorStore::default();

        let first = evaluate_laundry(&data, &watch(5), now, &cursors);
        assert_eq!(first.notifications.len(), 1);
        assert!(first.notifications[0].title.contains("5분 전"));
        assert_eq!(first.notifications[0].action, NotificationAction::Laundry);
        cursors.record_notification(&first.notifications[0], now);

        let repeated = evaluate_laundry(&data, &watch(5), now + chrono::Duration::seconds(30), &cursors);
        assert!(repeated.notifications.is_empty());
    }

    #[test]
    fn 선택한_세탁_세션의_완료는_종료임박과_별도로_한번만_알린다() {
        let watch = watch(5);
        let mut cursors = EventCursorStore::default();
        let nearing = laundry("RUNNING", "ESTIMATED_RUNNING", "2026-07-27T09:05:00Z", "session-1");
        let before = evaluate_laundry(&nearing, &watch, utc(9, 0, 0), &cursors);
        cursors.record_notification(&before.notifications[0], utc(9, 0, 0));

        let completed = laundry("COMPLETED", "CONFIRMED_COMPLETED", "2026-07-27T09:05:00Z", "session-1");
        let result = evaluate_laundry(&completed, &watch, utc(9, 5, 0), &cursors);

        assert_eq!(result.notifications.len(), 1);
        assert!(result.notifications[0].title.contains("완료"));
        assert!(result.notifications[0].body.contains("꺼내 주세요"));
        assert_eq!(finished_watch(&result), Some(watch));
        assert_eq!(finished_status(&result), Some(LaundryTerminalStatus::Completed),);
    }

    #[test]
    fn 종료후_전원이_꺼진_세탁_세션도_완료로_알린다() {
        let mut data = laundry("IDLE", "IDLE", "", "session-1");
        data["machines"][0]["washer"]["estimatedFinishAt"] = Value::Null;
        data["events"] = serde_json::json!([{
            "machineId": "tower6",
            "appliance": "washer",
            "sessionId": "session-1",
            "type": "STATE_CHANGED",
            "previousState": "END",
            "currentState": "POWER_OFF"
        }]);

        let result = evaluate_laundry(&data, &watch(5), utc(9, 5, 0), &EventCursorStore::default());

        assert_eq!(result.notifications.len(), 1);
        assert!(result.notifications[0].title.contains("완료"));
    }

    #[test]
    fn 종료_임박_후_end를_놓치고_전원이_꺼지면_상태_확인_경고를_보낸다() {
        let now = utc(9, 0, 0);
        let watched = watch(5);
        let nearing = laundry("RUNNING", "ESTIMATED_RUNNING", "2026-07-27T09:05:00Z", "session-1");
        let mut cursors = EventCursorStore::default();
        let before = evaluate_laundry(&nearing, &watched, now, &cursors);
        cursors.record_notification(&before.notifications[0], now);

        let mut powered_off = laundry("IDLE", "IDLE", "", "session-1");
        powered_off["machines"][0]["washer"]["estimatedFinishAt"] = Value::Null;
        powered_off["events"] = serde_json::json!([{
            "machineId": "tower6",
            "appliance": "washer",
            "sessionId": "session-1",
            "type": "STOPPED_UNEXPECTEDLY",
            "previousState": "SPINNING",
            "currentState": "POWER_OFF"
        }]);

        let result = evaluate_laundry(&powered_off, &watched, now + chrono::Duration::minutes(5), &cursors);

        assert_eq!(result.notifications.len(), 1);
        assert_eq!(result.notifications[0].cursor.key, "laundry.washer.needs-check");
        assert_eq!(result.notifications[0].title, "세탁 상태 확인");
        assert!(result.notifications[0].body.contains("끝났거나 중단됐습니다"));
        assert!(result.baselines.is_empty());
        assert_eq!(finished_watch(&result), Some(watched.clone()));
        assert_eq!(finished_status(&result), Some(LaundryTerminalStatus::NeedsCheck),);

        cursors.record_notification(&result.notifications[0], now + chrono::Duration::minutes(5));
        assert!(finished_laundry_notification_recorded(&cursors, &watched));
        let repeated = evaluate_laundry(&powered_off, &watched, now + chrono::Duration::minutes(6), &cursors);
        assert!(repeated.notifications.is_empty());
        assert_eq!(finished_watch(&repeated), Some(watched));
    }

    #[test]
    fn 종료_임박_기록_없이_중간에_꺼진_세탁은_완료로_오인하지_않는다() {
        let mut powered_off = laundry("IDLE", "IDLE", "", "session-1");
        powered_off["machines"][0]["washer"]["estimatedFinishAt"] = Value::Null;

        let result = evaluate_laundry(&powered_off, &watch(5), utc(9, 0, 0), &EventCursorStore::default());

        assert!(result.notifications.is_empty());
    }

    #[test]
    fn 완료_알림이_등록되면_추적을_끝내고_사용자가_제거할때까지_대시보드에_남긴다() {
        let completed_at = utc(9, 5, 0);
        let completed = laundry("COMPLETED", "CONFIRMED_COMPLETED", "2026-07-27T09:05:00Z", "session-1");
        let finished = watch(5);
        let evaluation = evaluate_laundry(&completed, &finished, completed_at, &EventCursorStore::default());
        let mut cursors = EventCursorStore::default();
        assert!(!finished_laundry_notification_recorded(&cursors, &finished));
        cursors.record_notification(&evaluation.notifications[0], completed_at);
        assert!(finished_laundry_notification_recorded(&cursors, &finished));
        let runtime = LocalRuntime {
            cursors,
            laundry: Some(CampusSnapshot {
                saved_at: utc(9, 10, 0).timestamp_millis(),
                data: laundry("RUNNING", "ESTIMATED_RUNNING", "2026-07-27T09:40:00Z", "session-2"),
            }),
            ..LocalRuntime::default()
        };
        let mut config = Config {
            laundry_watch: Some(watch(5)),
            ..Config::default()
        };

        let finished_activity = evaluation.finished_laundry_activity.unwrap();
        assert!(retain_finished_laundry_activity(&mut config, &finished_activity,));
        assert!(config.laundry_watch.is_none());
        assert_eq!(config.laundry_terminal_activities, vec![finished_activity]);
        let dashboard = build_dashboard_snapshot(&config, &runtime, utc(9, 10, 0));
        assert!(dashboard.laundry.is_none());
        assert_eq!(dashboard.laundry_terminal_activities.len(), 1);
        assert_eq!(
            dashboard.laundry_terminal_activities[0].status,
            LaundryTerminalStatus::Completed,
        );
    }

    #[test]
    fn 다른_세탁_세션은_선택한_기기라도_알리지_않는다() {
        let data = laundry("RUNNING", "ESTIMATED_RUNNING", "2026-07-27T09:05:00Z", "session-2");

        let result = evaluate_laundry(&data, &watch(5), utc(9, 0, 0), &EventCursorStore::default());

        assert!(result.notifications.is_empty());
    }

    #[test]
    fn 종료_확인중에_새_세션이_두번_확인되면_기존_작업_완료로_알린다() {
        let watch = watch(5);
        let mut cursors = EventCursorStore::default();
        let awaiting = observed_at(
            laundry(
                "RUNNING",
                "AWAITING_COMPLETION_CONFIRMATION",
                "2026-07-27T09:05:00Z",
                "session-1",
            ),
            LaundryApplianceKind::Washer,
            "2026-07-27T09:05:00Z",
        );
        let awaiting_result = evaluate_laundry(&awaiting, &watch, utc(9, 5, 0), &cursors);
        assert_eq!(
            awaiting_result.laundry_tracking.as_ref().map(|tracking| tracking.phase),
            Some(LaundryTrackingPhase::AwaitingCompletion)
        );
        apply_laundry_tracking(&mut cursors, &awaiting_result);

        let replacement_first = checked_at(
            observed_at(
                laundry("RUNNING", "ESTIMATED_RUNNING", "2026-07-27T09:40:00Z", "session-2"),
                LaundryApplianceKind::Washer,
                "2026-07-27T09:06:00Z",
            ),
            "2026-07-27T09:06:00Z",
        );
        let first = evaluate_laundry(&replacement_first, &watch, utc(9, 6, 0), &cursors);
        assert!(first.notifications.is_empty());
        assert!(first.finished_laundry_activity.is_none());
        apply_laundry_tracking(&mut cursors, &first);

        let repeated_snapshot = evaluate_laundry(&replacement_first, &watch, utc(9, 6, 10), &cursors);
        assert!(repeated_snapshot.notifications.is_empty());
        assert!(repeated_snapshot.finished_laundry_activity.is_none());

        let replacement_confirmed = checked_at(
            observed_at(
                laundry("RUNNING", "ESTIMATED_RUNNING", "2026-07-27T09:39:30Z", "session-2"),
                LaundryApplianceKind::Washer,
                "2026-07-27T09:06:00Z",
            ),
            "2026-07-27T09:06:30Z",
        );
        let confirmed = evaluate_laundry(&replacement_confirmed, &watch, utc(9, 6, 30), &cursors);
        assert_eq!(confirmed.notifications.len(), 1);
        assert_eq!(confirmed.notifications[0].title, "세탁 완료");
        assert!(!confirmed.notifications[0].body.contains("새 작업"));
        assert_eq!(finished_watch(&confirmed), Some(watch));
    }

    #[test]
    fn 작동중에_새_세션이_두번_확인되면_새_작업을_알리고_추적을_끝낸다() {
        let watch = dryer_watch(5);
        let mut cursors = EventCursorStore::default();
        let running = observed_at(
            dryer("RUNNING", "ESTIMATED_RUNNING", "2026-07-27T09:40:00Z", "session-1"),
            LaundryApplianceKind::Dryer,
            "2026-07-27T09:00:00Z",
        );
        let running_result = evaluate_laundry(&running, &watch, utc(9, 0, 0), &cursors);
        apply_laundry_tracking(&mut cursors, &running_result);

        let first = observed_at(
            dryer("RUNNING", "ESTIMATED_RUNNING", "2026-07-27T10:00:00Z", "session-2"),
            LaundryApplianceKind::Dryer,
            "2026-07-27T09:10:00Z",
        );
        let first_result = evaluate_laundry(&first, &watch, utc(9, 10, 0), &cursors);
        assert!(first_result.notifications.is_empty());
        apply_laundry_tracking(&mut cursors, &first_result);

        let second = observed_at(
            dryer("RUNNING", "ESTIMATED_RUNNING", "2026-07-27T09:59:30Z", "session-2"),
            LaundryApplianceKind::Dryer,
            "2026-07-27T09:10:30Z",
        );
        let second_result = evaluate_laundry(&second, &watch, utc(9, 10, 30), &cursors);
        assert_eq!(second_result.notifications.len(), 1);
        assert_eq!(second_result.notifications[0].title, "새 건조 시작 감지");
        assert!(second_result.notifications[0].body.contains("기존 추적을 종료"));
        assert_eq!(finished_watch(&second_result), Some(watch.clone()));
        assert_eq!(finished_status(&second_result), Some(LaundryTerminalStatus::Replaced),);
        cursors.record_notification(&second_result.notifications[0], utc(9, 10, 30));
        assert!(finished_laundry_notification_recorded(&cursors, &watch));
    }

    #[test]
    fn 다른_세션이_두번_확인되면_idle이어도_기존_추적을_끝낸다() {
        let watched = watch(5);
        let mut cursors = EventCursorStore::default();
        let initial = checked_at(
            laundry("RUNNING", "ESTIMATED_RUNNING", "2026-07-27T09:40:00Z", "session-1"),
            "2026-07-27T09:00:00Z",
        );
        let initial_result = evaluate_laundry(&initial, &watched, utc(9, 0, 0), &cursors);
        apply_laundry_tracking(&mut cursors, &initial_result);

        let first = checked_at(laundry("IDLE", "IDLE", "", "session-2"), "2026-07-27T09:10:00Z");
        let first_result = evaluate_laundry(&first, &watched, utc(9, 10, 0), &cursors);
        assert!(first_result.finished_laundry_activity.is_none());
        assert!(first_result
            .laundry_tracking
            .as_ref()
            .and_then(|tracking| tracking.replacement_candidate.as_ref())
            .is_some());
        apply_laundry_tracking(&mut cursors, &first_result);

        let second = checked_at(laundry("IDLE", "IDLE", "", "session-2"), "2026-07-27T09:10:30Z");
        let second_result = evaluate_laundry(&second, &watched, utc(9, 10, 30), &cursors);

        assert_eq!(second_result.notifications.len(), 1);
        assert_eq!(second_result.notifications[0].title, "세탁 추적 종료");
        assert_eq!(finished_watch(&second_result), Some(watched));
    }

    #[test]
    fn 시간증가와_예약_idle_오래된_관측은_새_실행으로_판단하지_않는다() {
        let watch = watch(5);
        let mut cursors = EventCursorStore::default();
        let running = observed_at(
            laundry("RUNNING", "ESTIMATED_RUNNING", "2026-07-27T09:40:00Z", "session-1"),
            LaundryApplianceKind::Washer,
            "2026-07-27T09:00:00Z",
        );
        let running_result = evaluate_laundry(&running, &watch, utc(9, 0, 0), &cursors);
        apply_laundry_tracking(&mut cursors, &running_result);

        let extended = observed_at(
            laundry("RUNNING", "ESTIMATED_RUNNING", "2026-07-27T11:40:00Z", "session-1"),
            LaundryApplianceKind::Washer,
            "2026-07-27T09:01:00Z",
        );
        let extended_result = evaluate_laundry(&extended, &watch, utc(9, 1, 0), &cursors);
        assert!(extended_result.finished_laundry_activity.is_none());
        apply_laundry_tracking(&mut cursors, &extended_result);

        for status in ["SCHEDULED", "IDLE"] {
            let replacement = observed_at(
                laundry(status, "ESTIMATED_RUNNING", "", "session-2"),
                LaundryApplianceKind::Washer,
                "2026-07-27T09:02:00Z",
            );
            let result = evaluate_laundry(&replacement, &watch, utc(9, 2, 0), &cursors);
            assert!(result.notifications.is_empty());
            assert!(result.finished_laundry_activity.is_none());
        }

        let stale = observed_at(
            laundry("RUNNING", "ESTIMATED_RUNNING", "2026-07-27T10:00:00Z", "session-2"),
            LaundryApplianceKind::Washer,
            "2026-07-27T08:59:00Z",
        );
        let stale_result = evaluate_laundry(&stale, &watch, utc(9, 3, 0), &cursors);
        assert!(stale_result.notifications.is_empty());
        assert!(stale_result.finished_laundry_activity.is_none());
    }

    #[test]
    fn 같은_session_id라도_started_at이_바뀌면_새_실행으로_판단한다() {
        let watch = watch(5);
        let mut cursors = EventCursorStore::default();
        let original = observed_at(
            started_at(
                laundry("RUNNING", "ESTIMATED_RUNNING", "2026-07-27T09:40:00Z", "session-1"),
                LaundryApplianceKind::Washer,
                "2026-07-27T08:30:00Z",
            ),
            LaundryApplianceKind::Washer,
            "2026-07-27T09:00:00Z",
        );
        let original_result = evaluate_laundry(&original, &watch, utc(9, 0, 0), &cursors);
        apply_laundry_tracking(&mut cursors, &original_result);

        let restarted = |observed: &str| {
            observed_at(
                started_at(
                    laundry("RUNNING", "ESTIMATED_RUNNING", "2026-07-27T10:10:00Z", "session-1"),
                    LaundryApplianceKind::Washer,
                    "2026-07-27T09:10:00Z",
                ),
                LaundryApplianceKind::Washer,
                observed,
            )
        };
        let first = evaluate_laundry(&restarted("2026-07-27T09:10:00Z"), &watch, utc(9, 10, 0), &cursors);
        assert!(first.notifications.is_empty());
        apply_laundry_tracking(&mut cursors, &first);

        let second = evaluate_laundry(&restarted("2026-07-27T09:10:30Z"), &watch, utc(9, 10, 30), &cursors);
        assert_eq!(second.notifications.len(), 1);
        assert_eq!(second.notifications[0].title, "새 세탁 시작 감지");
        assert_eq!(finished_watch(&second), Some(watch));
    }

    #[test]
    fn 완료_이벤트와_새_세션이_같이_오면_완료_알림만_보낸다() {
        let mut data = observed_at(
            laundry("RUNNING", "ESTIMATED_RUNNING", "2026-07-27T09:40:00Z", "session-2"),
            LaundryApplianceKind::Washer,
            "2026-07-27T09:06:00Z",
        );
        data["events"] = serde_json::json!([{
            "machineId": "tower6",
            "appliance": "washer",
            "sessionId": "session-1",
            "type": "COMPLETED",
            "observedAt": "2026-07-27T09:05:30Z"
        }]);

        let result = evaluate_laundry(&data, &watch(5), utc(9, 6, 0), &EventCursorStore::default());

        assert_eq!(result.notifications.len(), 1);
        assert_eq!(result.notifications[0].title, "세탁 완료");
        assert!(!result.notifications[0].title.contains("새"));
    }

    #[test]
    fn 선택한_세탁_세션의_오류는_종료_알림보다_먼저_한번_알린다() {
        let watch = watch(5);
        let nearing = laundry("RUNNING", "ESTIMATED_RUNNING", "2026-07-27T09:05:00Z", "session-1");
        let mut cursors = EventCursorStore::default();
        let before = evaluate_laundry(&nearing, &watch, utc(9, 0, 0), &cursors);
        cursors.record_notification(&before.notifications[0], utc(9, 0, 0));

        let data = laundry("ERROR", "ERROR", "2026-07-27T09:05:00Z", "session-1");
        let first = evaluate_laundry(&data, &watch, utc(9, 1, 0), &cursors);
        assert_eq!(first.notifications.len(), 1);
        assert!(first.notifications[0].title.starts_with("!!!"));
        assert!(first.notifications[0].title.contains("오류"));
        assert!(first.notifications[0].body.contains("확인해 주세요"));
        assert_eq!(finished_watch(&first), Some(watch.clone()));
        assert_eq!(finished_status(&first), Some(LaundryTerminalStatus::Error),);
        cursors.record_notification(&first.notifications[0], utc(9, 1, 0));

        let repeated = evaluate_laundry(&data, &watch, utc(9, 2, 0), &cursors);
        assert!(repeated.notifications.is_empty());
        assert_eq!(finished_watch(&repeated), Some(watch));
    }

    #[test]
    fn 종료_임박과_일시정지는_세탁_추적을_끝내지_않는다() {
        let nearing = laundry("RUNNING", "ESTIMATED_RUNNING", "2026-07-27T09:05:00Z", "session-1");
        let before = evaluate_laundry(&nearing, &watch(5), utc(9, 0, 0), &EventCursorStore::default());
        assert_eq!(before.notifications.len(), 1);
        assert!(before.finished_laundry_activity.is_none());

        let paused = laundry("PAUSED", "PAUSED", "2026-07-27T09:05:00Z", "session-1");
        let paused_result = evaluate_laundry(&paused, &watch(5), utc(9, 0, 0), &EventCursorStore::default());
        assert_eq!(paused_result.notifications.len(), 1);
        assert!(paused_result.finished_laundry_activity.is_none());
    }

    #[test]
    fn 세탁기와_건조기_종료_확인중은_한번_알리고_추적을_유지한다() {
        for (watch, data, expected_title) in [
            (
                watch(5),
                laundry(
                    "RUNNING",
                    "AWAITING_COMPLETION_CONFIRMATION",
                    "2026-07-27T09:05:00Z",
                    "session-1",
                ),
                "세탁 종료 확인 중",
            ),
            (
                dryer_watch(5),
                dryer(
                    "RUNNING",
                    "AWAITING_COMPLETION_CONFIRMATION",
                    "2026-07-27T09:05:00Z",
                    "session-1",
                ),
                "건조 종료 확인 중",
            ),
        ] {
            let now = utc(9, 5, 0);
            let mut cursors = EventCursorStore::default();
            let first = evaluate_laundry(&data, &watch, now, &cursors);

            assert_eq!(first.notifications.len(), 1);
            assert_eq!(first.notifications[0].title, expected_title);
            assert!(first.notifications[0].cursor.key.ends_with(".awaiting-completion"));
            assert!(first.finished_laundry_activity.is_none());

            cursors.record_notification(&first.notifications[0], now);
            let repeated = evaluate_laundry(&data, &watch, now + chrono::Duration::seconds(30), &cursors);
            assert!(repeated.notifications.is_empty());
            assert!(repeated.finished_laundry_activity.is_none());
        }
    }

    #[test]
    fn 건조기도_완료와_오류_알림후_추적을_끝낸다() {
        let watch = dryer_watch(5);
        for (status, projection, expected_title) in [
            ("COMPLETED", "CONFIRMED_COMPLETED", "건조 완료"),
            ("ERROR", "ERROR", "건조기 오류"),
        ] {
            let result = evaluate_laundry(
                &dryer(status, projection, "2026-07-27T09:05:00Z", "session-1"),
                &watch,
                utc(9, 5, 0),
                &EventCursorStore::default(),
            );

            assert_eq!(result.notifications.len(), 1);
            assert!(result.notifications[0].title.contains(expected_title));
            assert_eq!(finished_watch(&result), Some(watch.clone()));
        }
    }

    #[test]
    fn 늦게_도착한_종결_처리는_새_추적을_보존하며_종료_항목만_추가한다() {
        let finished = watch(5);
        let activity = finished_laundry_activity(&finished, LaundryTerminalStatus::Completed, utc(9, 5, 0));
        let mut config = Config {
            laundry_watch: Some(finished.clone()),
            ..Config::default()
        };

        assert!(retain_finished_laundry_activity(&mut config, &activity));
        assert!(config.laundry_watch.is_none());
        assert_eq!(config.laundry_terminal_activities, vec![activity.clone()]);

        let replacement = LaundryWatch {
            session_id: "session-2".into(),
            ..watch(5)
        };
        let mut raced_config = Config {
            laundry_watch: Some(replacement.clone()),
            ..Config::default()
        };
        assert!(retain_finished_laundry_activity(&mut raced_config, &activity,));
        assert_eq!(raced_config.laundry_watch, Some(replacement));
        assert_eq!(raced_config.laundry_terminal_activities, vec![activity]);
    }

    #[test]
    fn 같은_세탁_세션의_종료_항목_id는_재평가_시각과_결과에_관계없이_안정적이다() {
        let watched = watch(5);
        let completed = finished_laundry_activity(&watched, LaundryTerminalStatus::Completed, utc(9, 5, 0));
        let retried = finished_laundry_activity(&watched, LaundryTerminalStatus::Error, utc(9, 6, 0));

        assert_eq!(completed.id, retried.id);
    }

    #[test]
    fn 세탁_종료_항목_id는_구분자가_포함된_기기와_세션도_충돌하지_않는다() {
        let first_watch = LaundryWatch {
            machine_id: "a".into(),
            session_id: "b:washer:c".into(),
            ..watch(5)
        };
        let second_watch = LaundryWatch {
            machine_id: "a:washer:b".into(),
            session_id: "c".into(),
            ..watch(5)
        };
        let first = finished_laundry_activity(&first_watch, LaundryTerminalStatus::Completed, utc(9, 5, 0));
        let second = finished_laundry_activity(&second_watch, LaundryTerminalStatus::Completed, utc(9, 5, 0));

        assert_ne!(first.id, second.id);
    }

    #[test]
    fn 선택한_세탁_세션의_일시정지는_한번만_알린다() {
        let data = laundry("PAUSED", "PAUSED", "2026-07-27T09:05:00Z", "session-1");
        let mut cursors = EventCursorStore::default();

        let first = evaluate_laundry(&data, &watch(5), utc(9, 0, 0), &cursors);
        assert_eq!(first.notifications.len(), 1);
        assert!(first.notifications[0].title.contains("일시 정지"));
        cursors.record_notification(&first.notifications[0], utc(9, 0, 0));

        let repeated = evaluate_laundry(&data, &watch(5), utc(9, 1, 0), &cursors);
        assert!(repeated.notifications.is_empty());
    }

    #[test]
    fn 주간_식단표만_바뀌어도_중식이나_석식_알림을_만들지_않는다() {
        let first = serde_json::json!({
            "data": {
                "currentWeeklyMenu": {
                    "targetWeekKey": "2026-07-27",
                    "status": "AVAILABLE",
                    "contentSha": "sha-1",
                    "post": { "title": "7월 4주차 식단" }
                }
            }
        });
        let changed = serde_json::json!({
            "data": {
                "currentWeeklyMenu": {
                    "targetWeekKey": "2026-07-27",
                    "status": "AVAILABLE",
                    "contentSha": "sha-2",
                    "post": { "title": "7월 4주차 식단 수정" }
                }
            }
        });
        let baseline = evaluate_meals(&first, true, utc(8, 0, 0), &EventCursorStore::default());
        let changed = evaluate_meals(&changed, true, utc(8, 1, 0), &EventCursorStore::default());
        assert!(baseline.notifications.is_empty());
        assert!(changed.notifications.is_empty());
    }

    #[test]
    fn 오늘_중식이_새로_게시되면_구독자에게_알린다() {
        let empty = serde_json::json!({
            "data": {
                "dailyMenus": [],
                "currentWeeklyMenu": {
                    "targetWeekKey": "2026-07-27",
                    "status": "AWAITING_UPDATE",
                    "contentSha": null,
                    "post": null
                }
            }
        });
        let lunch = serde_json::json!({
            "data": {
                "dailyMenus": [{
                    "id": "lunch-1",
                    "contentSha": "lunch-sha",
                    "title": "7월 27일 중식",
                    "text": "쌀밥\n김치찌개\n계란말이",
                    "publishedAt": "2026-07-27T01:05:00Z"
                }],
                "currentWeeklyMenu": {
                    "targetWeekKey": "2026-07-27",
                    "status": "AWAITING_UPDATE",
                    "contentSha": null,
                    "post": null
                }
            }
        });
        let mut cursors = EventCursorStore::default();
        let now = utc(1, 0, 0);

        let baseline = evaluate_meals(&empty, true, now, &cursors);
        assert_eq!(baseline.baselines.len(), 2);
        cursors.record_baselines(&baseline.baselines, now);

        let result = evaluate_meals(&lunch, true, now + Duration::minutes(5), &cursors);
        assert_eq!(result.notifications.len(), 1);
        assert!(result.notifications[0].title.contains("중식"));
        assert_eq!(result.notifications[0].body, "쌀밥 · 김치찌개 · 계란말이");
        assert_eq!(result.notifications[0].conflict_key, None);
        assert!(result.baselines.is_empty());
    }

    #[test]
    fn 중식과_석식이_함께_올라오면_공통_알림을_각각_만든다() {
        let empty = serde_json::json!({
            "data": {
                "dailyMenus": [],
                "currentWeeklyMenu": {
                    "targetWeekKey": "2026-07-27",
                    "status": "AWAITING_UPDATE",
                    "contentSha": null,
                    "post": null
                }
            }
        });
        let published = serde_json::json!({
            "data": {
                "dailyMenus": [
                    {
                        "id": "lunch-1",
                        "contentSha": "lunch-sha",
                        "title": "7월 27일 중식",
                        "text": "쌀밥\n김치찌개",
                        "publishedAt": "2026-07-27T01:05:00Z"
                    },
                    {
                        "id": "dinner-1",
                        "contentSha": "dinner-sha",
                        "title": "7월 27일 석식",
                        "text": "카레라이스\n샐러드",
                        "publishedAt": "2026-07-27T08:05:00Z"
                    }
                ],
                "currentWeeklyMenu": {
                    "targetWeekKey": "2026-07-27",
                    "status": "AWAITING_UPDATE",
                    "contentSha": null,
                    "post": null
                }
            }
        });
        let now = utc(1, 0, 0);
        let mut cursors = EventCursorStore::default();
        let baseline = evaluate_meals(&empty, true, now, &cursors);
        cursors.record_baselines(&baseline.baselines, now);

        let result = evaluate_meals(&published, true, now + Duration::hours(8), &cursors);

        assert!(result.baselines.is_empty());
        assert_eq!(result.notifications.len(), 2);
        assert!(result
            .notifications
            .iter()
            .all(|notification| notification.action == NotificationAction::Meals));
        assert!(result
            .notifications
            .iter()
            .all(|notification| notification.conflict_key.is_none()));
        assert!(result
            .notifications
            .iter()
            .any(|notification| notification.title.contains("중식")));
        assert!(result
            .notifications
            .iter()
            .any(|notification| notification.title.contains("석식")));
        let lunch_notification = result
            .notifications
            .iter()
            .find(|notification| notification.cursor.key == MEAL_LUNCH_CURSOR_KEY)
            .unwrap();
        let dinner_notification = result
            .notifications
            .iter()
            .find(|notification| notification.cursor.key == MEAL_DINNER_CURSOR_KEY)
            .unwrap();
        assert_eq!(lunch_notification.body, "쌀밥 · 김치찌개");
        assert_eq!(dinner_notification.body, "카레라이스 · 샐러드");
        assert_ne!(
            notification_source_key(lunch_notification),
            notification_source_key(dinner_notification)
        );
    }

    #[test]
    fn 출석_마감_5분전에는_일반_알림을_긴급_알림으로_합친다() {
        let kst = FixedOffset::east_opt(9 * 3600)
            .unwrap()
            .with_ymd_and_hms(2026, 7, 28, 3, 55, 0)
            .unwrap();
        let now = kst.with_timezone(&Utc);
        let state = AttendanceLocalState {
            phase: DailyPhase::NeedEnd,
            remaining: Some(300),
            needs_login: false,
            attendance_date: "2026-07-27".into(),
        };
        let mut cursors = EventCursorStore::default();

        let result = evaluate_attendance(&Config::default(), &state, now, &cursors);
        assert_eq!(result.notifications.len(), 1);
        assert!(result.notifications[0].title.starts_with("!!!"));
        assert_eq!(result.notifications[0].coalesced_cursors.len(), 1);
        cursors.record_notification(&result.notifications[0], now);

        let repeated = evaluate_attendance(
            &Config::default(),
            &AttendanceLocalState {
                remaining: Some(240),
                ..state
            },
            now + chrono::Duration::minutes(1),
            &cursors,
        );
        assert!(repeated.notifications.is_empty());
    }

    #[test]
    fn 로컬_알림_source_key는_병합_cursor_구성과_무관하게_primary_identity를_사용한다() {
        let first = LocalNotification {
            cursor: CursorMark {
                key: "source.b".into(),
                fingerprint: "fingerprint-b".into(),
            },
            title: "알림".into(),
            body: "내용".into(),
            action: NotificationAction::Meals,
            conflict_key: Some("conflict".into()),
            priority: 10,
            coalesced_cursors: vec![CursorMark {
                key: "source.a".into(),
                fingerprint: "fingerprint-a".into(),
            }],
        };
        let without_coalesced = LocalNotification {
            coalesced_cursors: Vec::new(),
            ..first.clone()
        };

        assert_eq!(
            notification_source_key(&first),
            notification_source_key(&without_coalesced)
        );
    }

    #[test]
    fn 일반_출퇴근_알림만_15분_반복을_허용한다() {
        let regular = LocalNotification {
            cursor: CursorMark {
                key: ATTENDANCE_START_CURSOR_KEY.into(),
                fingerprint: "2026-07-29".into(),
            },
            title: "출석".into(),
            body: "내용".into(),
            action: NotificationAction::Attendance,
            conflict_key: None,
            priority: 10,
            coalesced_cursors: Vec::new(),
        };
        let urgent = LocalNotification {
            cursor: CursorMark {
                key: ATTENDANCE_URGENT_CURSOR_KEY.into(),
                fingerprint: "2026-07-29".into(),
            },
            ..regular.clone()
        };

        assert_eq!(
            notification_repeat_after_ms(&regular),
            Some(ATTENDANCE_NOTIFICATION_REPEAT_MINS * 60 * 1_000)
        );
        assert_eq!(notification_repeat_after_ms(&urgent), None);
    }

    #[test]
    fn 재시작_복구는_현재시각이_아니라_기존_inbox_발송시각으로_cursor를_복원한다() {
        let fallback = utc(9, 30, 0);
        let original = utc(9, 0, 0);
        let report = crate::notification_service::DeliveryReport {
            inbox_recorded: true,
            inbox_created_at: Some(original.timestamp_millis()),
            ..crate::notification_service::DeliveryReport::default()
        };

        assert_eq!(notification_recorded_at(&report, fallback), original);
    }

    #[test]
    fn 출석_마감_임박은_일반_알림_간격이_남아도_알린다() {
        let kst = FixedOffset::east_opt(9 * 3600)
            .unwrap()
            .with_ymd_and_hms(2026, 7, 28, 3, 54, 0)
            .unwrap();
        let regular_at = kst.with_timezone(&Utc);
        let config = Config::default();
        let regular_state = AttendanceLocalState {
            phase: DailyPhase::NeedEnd,
            remaining: Some(360),
            needs_login: false,
            attendance_date: "2026-07-27".into(),
        };
        let mut cursors = EventCursorStore::default();
        let regular = evaluate_attendance(&config, &regular_state, regular_at, &cursors);
        assert_eq!(regular.notifications.len(), 1);
        cursors.record_notification(&regular.notifications[0], regular_at);

        let urgent = evaluate_attendance(
            &config,
            &AttendanceLocalState {
                remaining: Some(300),
                ..regular_state
            },
            regular_at + Duration::minutes(1),
            &cursors,
        );

        assert_eq!(urgent.notifications.len(), 1);
        assert_eq!(urgent.notifications[0].title, "!!! 퇴근 출석 마감 임박");
    }

    #[test]
    fn 출석_알림은_사용자_설정없이_15분_주기로_반복한다() {
        let kst = FixedOffset::east_opt(9 * 3600)
            .unwrap()
            .with_ymd_and_hms(2026, 7, 28, 9, 0, 0)
            .unwrap();
        let first_at = kst.with_timezone(&Utc);
        let state = AttendanceLocalState {
            phase: DailyPhase::NeedStart,
            remaining: Some(3600),
            needs_login: false,
            attendance_date: "2026-07-28".into(),
        };
        let mut cursors = EventCursorStore::default();

        let first = evaluate_attendance(&Config::default(), &state, first_at, &cursors);
        assert_eq!(first.notifications.len(), 1);
        assert_eq!(first.notifications[0].action, NotificationAction::Attendance);
        cursors.record_notification(&first.notifications[0], first_at);

        let before_boundary = evaluate_attendance(
            &Config::default(),
            &state,
            first_at + Duration::minutes(15) - Duration::seconds(1),
            &cursors,
        );
        assert!(before_boundary.notifications.is_empty());

        let at_boundary = evaluate_attendance(&Config::default(), &state, first_at + Duration::minutes(15), &cursors);
        assert_eq!(at_boundary.notifications.len(), 1);
    }

    #[test]
    fn 종료_출석_알림도_같은_15분_주기로_반복한다() {
        let kst = FixedOffset::east_opt(9 * 3600)
            .unwrap()
            .with_ymd_and_hms(2026, 7, 28, 23, 0, 0)
            .unwrap();
        let first_at = kst.with_timezone(&Utc);
        let state = AttendanceLocalState {
            phase: DailyPhase::NeedEnd,
            remaining: Some(5 * 60 * 60),
            needs_login: false,
            attendance_date: "2026-07-28".into(),
        };
        let mut cursors = EventCursorStore::default();

        let first = evaluate_attendance(&Config::default(), &state, first_at, &cursors);
        assert_eq!(first.notifications.len(), 1);
        assert_eq!(first.notifications[0].action, NotificationAction::Attendance);
        cursors.record_notification(&first.notifications[0], first_at);

        let before_boundary = evaluate_attendance(
            &Config::default(),
            &state,
            first_at + Duration::minutes(15) - Duration::seconds(1),
            &cursors,
        );
        assert!(before_boundary.notifications.is_empty());

        let at_boundary = evaluate_attendance(&Config::default(), &state, first_at + Duration::minutes(15), &cursors);
        assert_eq!(at_boundary.notifications.len(), 1);
    }

    #[test]
    fn 이벤트_커서는_고정된_kv만_파일에_저장하고_복구한다() {
        let path = std::env::temp_dir().join(format!(
            "jungle-bell-local-cursors-{}-{}.json",
            std::process::id(),
            now_unique_suffix()
        ));
        let mut cursors = EventCursorStore::default();
        cursors.record_baselines(
            &[CursorMark {
                key: MEAL_LUNCH_CURSOR_KEY.into(),
                fingerprint: "2026-07-27:lunch-sha".into(),
            }],
            utc(8, 0, 0),
        );
        cursors.laundry_tracking = Some(LaundryTrackingState {
            watch_fingerprint: laundry_watch_fingerprint(&watch(5)),
            phase: LaundryTrackingPhase::AwaitingCompletion,
            started_at: Some(utc(8, 0, 0)),
            observed_at: Some(utc(9, 5, 0)),
            replacement_candidate: Some(LaundryReplacementCandidate {
                session_id: "session-2".into(),
                started_at: Some(utc(9, 6, 0)),
                observed_at: utc(9, 6, 0),
            }),
        });

        cursors.save_to(&path).unwrap();
        let restored = EventCursorStore::load_from(&path).unwrap();

        assert_eq!(restored, cursors);
        let saved = fs::read_to_string(&path).unwrap();
        assert!(saved.contains(MEAL_LUNCH_CURSOR_KEY));
        assert!(!saved.contains("meal_alerts"));
        assert!(saved.contains("awaitingCompletion"));
        assert!(saved.contains("session-2"));
        assert!(!saved.contains("next_due_at"));
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn 이전_cursor의_meal_alerts는_읽은뒤_다시_저장하지_않는다() {
        let path = std::env::temp_dir().join(format!(
            "jungle-bell-local-cursors-legacy-meals-{}-{}.json",
            std::process::id(),
            now_unique_suffix()
        ));
        let legacy = serde_json::json!({
            "events": {
                "meals.daily.lunch": {
                    "fingerprint": "2026-07-27:lunch-sha",
                    "emitted_at": "2026-07-27T01:05:00Z"
                }
            },
            "meal_alerts": [{
                "id": "meal-alert-1",
                "period": "lunch",
                "title": "오늘 중식이 올라왔어요",
                "preview": "쌀밥 · 김치찌개",
                "dateKey": "2026-07-27",
                "publishedAt": "2026-07-27T01:05:00Z",
                "createdAt": utc(1, 5, 0).timestamp_millis()
            }],
            "laundry_tracking": null
        });
        fs::write(&path, serde_json::to_vec_pretty(&legacy).unwrap()).unwrap();

        let restored = EventCursorStore::load_from(&path).unwrap();
        assert_eq!(
            restored.events.get(MEAL_LUNCH_CURSOR_KEY),
            Some(&EventCursor {
                fingerprint: "2026-07-27:lunch-sha".into(),
                emitted_at: utc(1, 5, 0),
            })
        );
        restored.save_to(&path).unwrap();
        let reloaded = EventCursorStore::load_from(&path).unwrap();
        let saved = fs::read_to_string(&path).unwrap();

        assert_eq!(
            reloaded.events.get(MEAL_LUNCH_CURSOR_KEY),
            restored.events.get(MEAL_LUNCH_CURSOR_KEY)
        );
        assert!(!saved.contains("meal_alerts"));
        assert!(!saved.contains("meal-alert-1"));
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn 대시보드는_세탁_예약만_투영한다() {
        let mut config = Config {
            laundry_watch: Some(watch(5)),
            meal_subscription_enabled: true,
            ..Config::default()
        };
        let runtime = LocalRuntime {
            laundry: Some(CampusSnapshot {
                saved_at: utc(9, 0, 0).timestamp_millis(),
                data: laundry("RUNNING", "ESTIMATED_RUNNING", "2026-07-27T09:05:00Z", "session-1"),
            }),
            ..LocalRuntime::default()
        };

        let snapshot = build_dashboard_snapshot(&config, &runtime, utc(9, 0, 0));

        assert_eq!(
            snapshot.laundry.as_ref().map(|card| card.status),
            Some(LaundryDashboardStatus::Running)
        );
        assert_eq!(snapshot.laundry.as_ref().and_then(|card| card.total_minutes), Some(60));
        assert!(!serde_json::to_value(&snapshot)
            .unwrap()
            .as_object()
            .unwrap()
            .contains_key("mealAlerts"));

        config.laundry_watch = None;
        config.meal_subscription_enabled = false;
        let hidden = build_dashboard_snapshot(&config, &runtime, utc(9, 0, 0));
        assert!(hidden.laundry.is_none());
    }

    #[test]
    fn 대시보드는_새_추적과_제거하지_않은_종료_항목을_함께_투영한다() {
        let completed = finished_laundry_activity(&watch(5), LaundryTerminalStatus::Completed, utc(8, 30, 0));
        let errored = finished_laundry_activity(&dryer_watch(5), LaundryTerminalStatus::Error, utc(8, 40, 0));
        let config = Config {
            laundry_watch: Some(LaundryWatch {
                session_id: "session-2".into(),
                ..watch(5)
            }),
            laundry_terminal_activities: vec![completed, errored],
            ..Config::default()
        };
        let runtime = LocalRuntime {
            laundry: Some(CampusSnapshot {
                saved_at: utc(9, 0, 0).timestamp_millis(),
                data: laundry("RUNNING", "ESTIMATED_RUNNING", "2026-07-27T09:30:00Z", "session-2"),
            }),
            ..LocalRuntime::default()
        };

        let dashboard = build_dashboard_snapshot(&config, &runtime, utc(9, 0, 0));

        assert_eq!(
            dashboard.laundry.as_ref().map(|activity| &activity.session_id),
            Some(&"session-2".to_string()),
        );
        assert_eq!(dashboard.laundry_terminal_activities.len(), 2);
        assert_eq!(
            dashboard.laundry_terminal_activities[0].status,
            LaundryTerminalStatus::Error,
        );
        assert_eq!(
            dashboard.laundry_terminal_activities[1].status,
            LaundryTerminalStatus::Completed,
        );
    }

    fn now_unique_suffix() -> u128 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    }
}
