//! 공통 Snapshot을 사용자 로컬 설정에 따라 대시보드와 상황 알림으로 변환한다.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use chrono::{DateTime, Datelike, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::Emitter;
use tauri_plugin_notification::NotificationExt;
use tokio::sync::Mutex;

use crate::attendance_day;
use crate::campus::{CampusDataKind, CampusSnapshot};
use crate::config::{Config, LaundryApplianceKind, LaundryWatch};
use crate::state::{AppState, DailyPhase};

const MEAL_CURSOR_KEY: &str = "meals.current-weekly";
const MEAL_LUNCH_CURSOR_KEY: &str = "meals.daily.lunch";
const MEAL_DINNER_CURSOR_KEY: &str = "meals.daily.dinner";
const ATTENDANCE_START_CURSOR_KEY: &str = "attendance.start";
const ATTENDANCE_END_CURSOR_KEY: &str = "attendance.end";
const ATTENDANCE_URGENT_CURSOR_KEY: &str = "attendance.end-deadline";
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
    conflict_key: Option<String>,
    priority: u8,
    coalesced_cursors: Vec<CursorMark>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
struct LocalEvaluation {
    baselines: Vec<CursorMark>,
    notifications: Vec<LocalNotification>,
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
    pub estimated_finish_at: Option<String>,
    pub updated_at: Option<i64>,
    pub source_freshness: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MealDashboardStatus {
    Loading,
    AwaitingUpdate,
    Available,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MealDashboardCard {
    pub target_week_key: Option<String>,
    pub title: Option<String>,
    pub status: MealDashboardStatus,
    pub lunch_title: Option<String>,
    pub dinner_title: Option<String>,
    pub updated_at: Option<i64>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalDashboardSnapshot {
    pub laundry: Option<LaundryDashboardCard>,
    pub meals: Option<MealDashboardCard>,
}

#[derive(Debug, Default)]
struct LocalRuntime {
    cursors: EventCursorStore,
    laundry: Option<CampusSnapshot>,
    meals: Option<CampusSnapshot>,
}

pub struct LocalConsumptionService {
    state: Arc<Mutex<AppState>>,
    runtime: Mutex<LocalRuntime>,
}

impl LocalConsumptionService {
    pub fn new(state: Arc<Mutex<AppState>>) -> Self {
        let cursors = EventCursorStore::load().unwrap_or_else(|error| {
            log::warn!("[local-consumption] {error}; 빈 이벤트 커서로 시작합니다");
            EventCursorStore::default()
        });
        Self {
            state,
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
        let cursors_changed = Self::apply_evaluation(app, &mut runtime, evaluation, now);
        if cursors_changed {
            persist_event_cursors(runtime.cursors.clone()).await;
        }
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
        let cursors_changed = Self::apply_evaluation(app, &mut runtime, evaluation, now);
        if cursors_changed {
            persist_event_cursors(runtime.cursors.clone()).await;
        }
    }

    pub async fn on_settings_changed(&self, app: &tauri::AppHandle, reset_meal_baseline: bool) {
        let config = self.state.lock().await.config.clone();
        let now = Utc::now();
        let mut runtime = self.runtime.lock().await;
        let mut cursor_changed = false;
        if reset_meal_baseline {
            for key in [MEAL_CURSOR_KEY, MEAL_LUNCH_CURSOR_KEY, MEAL_DINNER_CURSOR_KEY] {
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
        cursor_changed |= Self::apply_evaluation(app, &mut runtime, evaluation, now);
        if cursor_changed {
            persist_event_cursors(runtime.cursors.clone()).await;
        }
        let dashboard = build_dashboard_snapshot(&config, &runtime, now);
        drop(runtime);
        emit_dashboard_snapshot(app, &dashboard);
    }

    pub async fn dashboard_snapshot(&self) -> LocalDashboardSnapshot {
        let config = self.state.lock().await.config.clone();
        let runtime = self.runtime.lock().await;
        build_dashboard_snapshot(&config, &runtime, Utc::now())
    }

    fn apply_evaluation(
        app: &tauri::AppHandle,
        runtime: &mut LocalRuntime,
        evaluation: LocalEvaluation,
        now: DateTime<Utc>,
    ) -> bool {
        let mut changed = !evaluation.baselines.is_empty();
        runtime.cursors.record_baselines(&evaluation.baselines, now);
        for notification in evaluation.notifications {
            match app
                .notification()
                .builder()
                .title(&notification.title)
                .body(&notification.body)
                .show()
            {
                Ok(_) => {
                    log::info!(
                        "[local-consumption] notification sent: key={} priority={}",
                        notification.cursor.key,
                        notification.priority
                    );
                    runtime.cursors.record_notification(&notification, now);
                    changed = true;
                }
                Err(error) => {
                    log::error!(
                        "[local-consumption] notification failed: key={} error={error}",
                        notification.cursor.key
                    );
                }
            }
        }
        changed
    }
}

async fn persist_event_cursors(cursors: EventCursorStore) {
    let result = tauri::async_runtime::spawn_blocking(move || cursors.save()).await;
    match result {
        Ok(Ok(())) => {}
        Ok(Err(error)) => log::error!("[local-consumption] {error}"),
        Err(error) => log::error!("[local-consumption] 이벤트 커서 저장 작업 실패: {error}"),
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
    target.notifications = coalesce_notifications(std::mem::take(&mut target.notifications));
}

fn build_dashboard_snapshot(config: &Config, runtime: &LocalRuntime, now: DateTime<Utc>) -> LocalDashboardSnapshot {
    LocalDashboardSnapshot {
        laundry: config
            .laundry_watch
            .as_ref()
            .map(|watch| build_laundry_dashboard_card(watch, runtime)),
        meals: config
            .meal_subscription_enabled
            .then(|| build_meal_dashboard_card(runtime.meals.as_ref(), now)),
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

fn build_meal_dashboard_card(snapshot: Option<&CampusSnapshot>, now: DateTime<Utc>) -> MealDashboardCard {
    let current = snapshot
        .and_then(|snapshot| snapshot.data.get("data"))
        .and_then(|data| data.get("currentWeeklyMenu"));
    let status = match current.and_then(|menu| menu.get("status")).and_then(Value::as_str) {
        Some("AVAILABLE") => MealDashboardStatus::Available,
        Some("AWAITING_UPDATE") => MealDashboardStatus::AwaitingUpdate,
        _ => MealDashboardStatus::Loading,
    };
    MealDashboardCard {
        target_week_key: current
            .and_then(|menu| menu.get("targetWeekKey"))
            .and_then(Value::as_str)
            .map(str::to_owned),
        title: current
            .and_then(|menu| menu.get("post"))
            .and_then(|post| post.get("title"))
            .and_then(Value::as_str)
            .map(str::to_owned),
        status,
        lunch_title: today_meal_title(snapshot, now, "중식"),
        dinner_title: today_meal_title(snapshot, now, "석식"),
        updated_at: snapshot.map(|snapshot| snapshot.saved_at),
    }
}

fn today_meal_title(snapshot: Option<&CampusSnapshot>, now: DateTime<Utc>, period: &str) -> Option<String> {
    let kst_now = now.with_timezone(&crate::state::kst());
    snapshot
        .and_then(|snapshot| snapshot.data.get("data"))
        .and_then(|data| data.get("dailyMenus"))
        .and_then(Value::as_array)
        .and_then(|posts| {
            posts.iter().find(|post| {
                meal_post_is_today(post, kst_now)
                    && post
                        .get("title")
                        .and_then(Value::as_str)
                        .is_some_and(|title| title.contains(period))
            })
        })
        .and_then(|post| post.get("title"))
        .and_then(Value::as_str)
        .map(str::to_owned)
}

#[derive(Debug, Clone)]
struct AttendanceLocalState {
    phase: DailyPhase,
    remaining: Option<i64>,
    needs_login: bool,
    attendance_date: String,
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

    let mut evaluation = LocalEvaluation::default();
    let session_conflict = Some(format!(
        "laundry:{}:{}:{}",
        watch.machine_id, appliance_key, watch.session_id
    ));
    if completed {
        let mark = laundry_completion_mark(watch);
        if !cursors.has_fingerprint(&mark) {
            evaluation.baselines.push(mark.clone());
            evaluation.notifications.push(LocalNotification {
                cursor: mark,
                title: format!("{appliance_label} 완료"),
                body: format!(
                    "{} {appliance_device_label}가 끝났습니다.",
                    laundry_machine_name(&watch.machine_id)
                ),
                conflict_key: session_conflict,
                priority: 80,
                coalesced_cursors: Vec::new(),
            });
        }
        return evaluation;
    }

    if !current_matches {
        return evaluation;
    }
    let Some(appliance) = machine_label else {
        return evaluation;
    };
    let operational_status = appliance
        .get("operationalStatus")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let projection_status = appliance
        .get("projection")
        .and_then(|projection| projection.get("status"))
        .and_then(Value::as_str)
        .unwrap_or_default();
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
        let mark = CursorMark {
            key: format!("laundry.{appliance_key}.{attention_kind}"),
            fingerprint: format!("{}:{}", watch.machine_id, watch.session_id),
        };
        if !cursors.has_fingerprint(&mark) {
            evaluation.notifications.push(LocalNotification {
                cursor: mark,
                title,
                body,
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

    let mark = CursorMark {
        key: format!("laundry.{appliance_key}.before"),
        fingerprint: format!("{}:{}:{}", watch.machine_id, watch.session_id, watch.notify_before_mins),
    };
    if !cursors.has_fingerprint(&mark) {
        evaluation.notifications.push(LocalNotification {
            cursor: mark,
            title: format!("{appliance_label} 종료 {}분 전", watch.notify_before_mins),
            body: format!(
                "{} {appliance_device_label}가 곧 끝납니다.",
                laundry_machine_name(&watch.machine_id)
            ),
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
        for (period, cursor_key, label) in [
            ("중식", MEAL_LUNCH_CURSOR_KEY, "중식"),
            ("석식", MEAL_DINNER_CURSOR_KEY, "석식"),
        ] {
            let post = daily_menus.iter().find(|post| {
                meal_post_is_today(post, kst_now)
                    && post
                        .get("title")
                        .and_then(Value::as_str)
                        .is_some_and(|title| title.contains(period))
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
            let body = post
                .and_then(|post| post.get("title"))
                .and_then(Value::as_str)
                .unwrap_or("새 식단")
                .to_string();
            evaluation.notifications.push(LocalNotification {
                cursor: mark,
                title: format!("오늘 {label}이 게시됐습니다"),
                body,
                conflict_key: Some("meal-publication".into()),
                priority: 30,
                coalesced_cursors: Vec::new(),
            });
        }
    }

    if let Some(current_weekly) = meals
        .get("currentWeeklyMenu")
        .filter(|menu| menu.get("status").and_then(Value::as_str) == Some("AVAILABLE"))
    {
        if let (Some(target_week), Some(content_sha)) = (
            current_weekly.get("targetWeekKey").and_then(Value::as_str),
            current_weekly.get("contentSha").and_then(Value::as_str),
        ) {
            let mark = CursorMark {
                key: MEAL_CURSOR_KEY.into(),
                fingerprint: format!("{target_week}:{content_sha}"),
            };
            if !cursors.has_fingerprint(&mark) {
                if !cursors.events.contains_key(MEAL_CURSOR_KEY) {
                    evaluation.baselines.push(mark);
                } else {
                    let meal_title = current_weekly
                        .get("post")
                        .and_then(|post| post.get("title"))
                        .and_then(Value::as_str)
                        .unwrap_or("새 주간 식단");
                    evaluation.notifications.push(LocalNotification {
                        cursor: mark,
                        title: "새 급식 식단표가 게시됐습니다".into(),
                        body: meal_title.into(),
                        conflict_key: Some("meal-publication".into()),
                        priority: 20,
                        coalesced_cursors: Vec::new(),
                    });
                }
            }
        }
    }

    evaluation.notifications = coalesce_notifications(evaluation.notifications);
    evaluation
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
        let interval_mins = match state.phase {
            DailyPhase::NeedStart | DailyPhase::StartOverdue => config.start_notification_interval_mins,
            DailyPhase::NeedEnd => config.end_notification_interval_mins,
            _ => 0,
        };
        let mark = CursorMark {
            key: cursor_key.into(),
            fingerprint: state.attendance_date.clone(),
        };
        let cooldown_elapsed = cursors.events.get(cursor_key).is_none_or(|cursor| {
            cursor.fingerprint != mark.fingerprint
                || now.signed_duration_since(cursor.emitted_at) >= Duration::minutes(i64::from(interval_mins))
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
                conflict_key: Some("attendance-notification".into()),
                priority: 100,
                coalesced_cursors: Vec::new(),
            });
        }
    }

    LocalEvaluation {
        baselines: Vec::new(),
        notifications: coalesce_notifications(candidates),
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
                    "estimatedFinishAt": finish_at,
                    "sessionId": session_id
                },
                "dryer": null
            }],
            "events": [],
            "quality": {}
        })
    }

    #[test]
    fn 선택한_세탁_세션은_종료_n분전에_한번만_알린다() {
        let now = utc(9, 0, 0);
        let data = laundry("RUNNING", "ESTIMATED_RUNNING", "2026-07-27T09:05:00Z", "session-1");
        let mut cursors = EventCursorStore::default();

        let first = evaluate_laundry(&data, &watch(5), now, &cursors);
        assert_eq!(first.notifications.len(), 1);
        assert!(first.notifications[0].title.contains("5분 전"));
        cursors.record_notification(&first.notifications[0], now);

        let repeated = evaluate_laundry(&data, &watch(5), now + chrono::Duration::seconds(30), &cursors);
        assert!(repeated.notifications.is_empty());
    }

    #[test]
    fn 선택한_세탁_세션의_완료는_종료임박과_별도로_한번만_알린다() {
        let now = utc(9, 5, 0);
        let data = laundry("COMPLETED", "CONFIRMED_COMPLETED", "2026-07-27T09:05:00Z", "session-1");

        let result = evaluate_laundry(&data, &watch(5), now, &EventCursorStore::default());

        assert_eq!(result.notifications.len(), 1);
        assert!(result.notifications[0].title.contains("완료"));
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
    fn 완료된_세탁_알림은_사용자가_해제할때까지_대시보드에_남는다() {
        let completed_at = utc(9, 5, 0);
        let completed = laundry("COMPLETED", "CONFIRMED_COMPLETED", "2026-07-27T09:05:00Z", "session-1");
        let evaluation = evaluate_laundry(&completed, &watch(5), completed_at, &EventCursorStore::default());
        let mut cursors = EventCursorStore::default();
        cursors.record_baselines(&evaluation.baselines, completed_at);
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

        let retained = build_dashboard_snapshot(&config, &runtime, utc(9, 10, 0));
        assert_eq!(
            retained.laundry.as_ref().map(|card| card.status),
            Some(LaundryDashboardStatus::Completed)
        );

        config.laundry_watch = None;
        let dismissed = build_dashboard_snapshot(&config, &runtime, utc(9, 10, 0));
        assert!(dismissed.laundry.is_none());
    }

    #[test]
    fn 다른_세탁_세션은_선택한_기기라도_알리지_않는다() {
        let data = laundry("RUNNING", "ESTIMATED_RUNNING", "2026-07-27T09:05:00Z", "session-2");

        let result = evaluate_laundry(&data, &watch(5), utc(9, 0, 0), &EventCursorStore::default());

        assert!(result.notifications.is_empty());
    }

    #[test]
    fn 선택한_세탁_세션의_오류는_종료_알림보다_먼저_한번_알린다() {
        let data = laundry("ERROR", "ERROR", "2026-07-27T09:05:00Z", "session-1");
        let mut cursors = EventCursorStore::default();

        let first = evaluate_laundry(&data, &watch(5), utc(9, 0, 0), &cursors);
        assert_eq!(first.notifications.len(), 1);
        assert!(first.notifications[0].title.starts_with("!!!"));
        assert!(first.notifications[0].title.contains("오류"));
        cursors.record_notification(&first.notifications[0], utc(9, 0, 0));

        let repeated = evaluate_laundry(&data, &watch(5), utc(9, 1, 0), &cursors);
        assert!(repeated.notifications.is_empty());
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
    fn 급식은_첫_snapshot을_기준점으로_삼고_새_content_sha만_알린다() {
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
        let mut cursors = EventCursorStore::default();

        let baseline = evaluate_meals(&first, true, utc(8, 0, 0), &cursors);
        assert!(baseline.notifications.is_empty());
        assert_eq!(baseline.baselines.len(), 1);
        cursors.record_baselines(&baseline.baselines, utc(8, 0, 0));

        let result = evaluate_meals(&changed, true, utc(8, 1, 0), &cursors);
        assert_eq!(result.notifications.len(), 1);
        assert!(result.notifications[0].title.contains("급식"));
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
    fn 이벤트_커서는_고정된_kv만_파일에_저장하고_복구한다() {
        let path = std::env::temp_dir().join(format!(
            "jungle-bell-local-cursors-{}-{}.json",
            std::process::id(),
            now_unique_suffix()
        ));
        let mut cursors = EventCursorStore::default();
        cursors.record_baselines(
            &[CursorMark {
                key: MEAL_CURSOR_KEY.into(),
                fingerprint: "2026-07-27:sha-1".into(),
            }],
            utc(8, 0, 0),
        );

        cursors.save_to(&path).unwrap();
        let restored = EventCursorStore::load_from(&path).unwrap();

        assert_eq!(restored, cursors);
        let saved = fs::read_to_string(&path).unwrap();
        assert!(saved.contains(MEAL_CURSOR_KEY));
        assert!(!saved.contains("next_due_at"));
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn 대시보드는_사용자가_선택한_세탁과_급식만_투영한다() {
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
            meals: Some(CampusSnapshot {
                saved_at: utc(8, 0, 0).timestamp_millis(),
                data: serde_json::json!({
                    "data": {
                        "currentWeeklyMenu": {
                            "targetWeekKey": "2026-07-27",
                            "status": "AVAILABLE",
                            "contentSha": "sha-1",
                            "post": { "title": "7월 4주차 식단" }
                        }
                    }
                }),
            }),
            ..LocalRuntime::default()
        };

        let snapshot = build_dashboard_snapshot(&config, &runtime, utc(9, 0, 0));

        assert_eq!(
            snapshot.laundry.as_ref().map(|card| card.status),
            Some(LaundryDashboardStatus::Running)
        );
        assert_eq!(
            snapshot.meals.as_ref().map(|card| card.status),
            Some(MealDashboardStatus::Available)
        );

        config.laundry_watch = None;
        config.meal_subscription_enabled = false;
        let hidden = build_dashboard_snapshot(&config, &runtime, utc(9, 0, 0));
        assert!(hidden.laundry.is_none());
        assert!(hidden.meals.is_none());
    }

    fn now_unique_suffix() -> u128 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    }
}
