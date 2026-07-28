use std::path::PathBuf;
use std::sync::Arc;

use serde::Serialize;
use tauri::Emitter;
use tokio::sync::Mutex;

use crate::attendance::{self, CohortOption, CohortResolution};
use crate::attendance_day;
use crate::config::{self, Config, LaundryWatch, NotificationDelivery, TimeOfDay};
use crate::state::{self, AppState};

pub const SETTINGS_CHANGED_EVENT: &str = "settings-changed";
const SETTINGS_WINDOW_LABELS: [&str; 3] = ["settings", "onboarding", "campus"];

/// 설정/온보딩 UI가 한 번에 소비하는 설정 read model.
///
/// 내부 스케줄 경계, 마이그레이션 플래그 등 UI에 필요 없는 `Config` 필드는
/// IPC 경계에 노출하지 않는다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsSnapshot {
    pub revision: u64,
    pub source: String,
    pub app_version: String,
    pub pending_version: Option<String>,
    pub auto_start: bool,
    pub auto_update: bool,
    pub show_app_icon: bool,
    pub show_dday: bool,
    pub usage_analytics: bool,
    pub debug_mode: bool,
    pub skip_attendance: bool,
    pub skip_sunday: bool,
    pub start_notification: bool,
    pub end_notification: bool,
    pub notification_delivery: NotificationDelivery,
    pub notification_start: TimeOfDay,
    pub notification_end: TimeOfDay,
    pub start_interval: u32,
    pub end_interval: u32,
    pub selected_cohort_id: Option<String>,
    pub effective_cohort_id: Option<String>,
    pub cohort_options: Vec<CohortOption>,
    pub meal_subscription: bool,
    pub laundry_watch: Option<LaundryWatch>,
}

impl SettingsSnapshot {
    fn from_state(state: &AppState, app_version: &str) -> Self {
        let kst_now = chrono::Utc::now().with_timezone(&state::kst());
        Self {
            revision: state.settings_revision,
            source: state.settings_source.clone(),
            app_version: app_version.to_string(),
            pending_version: state.pending_update.clone(),
            auto_start: state.config.auto_start,
            auto_update: state.config.auto_update,
            show_app_icon: state.config.show_app_icon,
            show_dday: state.config.show_dday,
            usage_analytics: state.config.usage_analytics_enabled,
            debug_mode: state.config.debug_mode,
            skip_attendance: attendance_day::is_skip_attendance_active(&state.config, kst_now),
            skip_sunday: state.config.skip_sunday,
            start_notification: state.config.start_notification_enabled,
            end_notification: state.config.end_notification_enabled,
            notification_delivery: state.config.notification_delivery,
            notification_start: state.config.notification_start.clone(),
            notification_end: state.config.notification_end.clone(),
            start_interval: state.config.start_notification_interval_mins,
            end_interval: state.config.end_notification_interval_mins,
            selected_cohort_id: state.config.selected_cohort_id.clone(),
            effective_cohort_id: state.effective_cohort_id.clone(),
            cohort_options: state.cohort_options.clone(),
            meal_subscription: state.config.meal_subscription_enabled,
            laundry_watch: state.config.laundry_watch.clone(),
        }
    }
}

pub struct SettingsCommit<R> {
    pub value: R,
    pub changed: bool,
    pub snapshot: SettingsSnapshot,
}

/// 설정 파일 쓰기를 직렬화하고, 성공한 저장만 `AppState`에 반영한다.
///
/// 파일 생성·flush·rename·directory fsync는 blocking thread에서 실행한다.
/// 전용 `writes` 잠금은 저장 순서만 보호하며 `AppState` 잠금은 파일 I/O 동안
/// 보유하지 않는다.
pub struct SettingsService {
    state: Arc<Mutex<AppState>>,
    path: Option<PathBuf>,
    app_version: String,
    writes: Mutex<()>,
}

impl SettingsService {
    pub fn new(state: Arc<Mutex<AppState>>, app_version: String) -> Self {
        Self::with_path(state, config::config_path(), app_version)
    }

    fn with_path(state: Arc<Mutex<AppState>>, path: Option<PathBuf>, app_version: String) -> Self {
        Self {
            state,
            path,
            app_version,
            writes: Mutex::new(()),
        }
    }

    pub async fn snapshot(&self) -> SettingsSnapshot {
        let state = self.state.lock().await;
        SettingsSnapshot::from_state(&state, &self.app_version)
    }

    async fn persist(&self, config: Config) -> Result<(), String> {
        let path = self
            .path
            .clone()
            .ok_or_else(|| "운영체제 설정 디렉토리를 확인할 수 없습니다.".to_string())?;
        tauri::async_runtime::spawn_blocking(move || config.save_to(&path))
            .await
            .map_err(|error| format!("설정 저장 작업 실행 실패: {error}"))?
    }

    pub async fn commit_config<R, F>(&self, source: &str, mutate: F) -> Result<SettingsCommit<R>, String>
    where
        R: Send,
        F: FnOnce(&mut Config) -> Result<R, String> + Send,
    {
        self.commit_config_with_effect(source, mutate, |_, _| Ok(()), |_, _| Ok(()))
            .await
    }

    pub async fn commit_config_with_effect<R, F, E, U>(
        &self,
        source: &str,
        mutate: F,
        apply_effect: E,
        rollback_effect: U,
    ) -> Result<SettingsCommit<R>, String>
    where
        R: Send,
        F: FnOnce(&mut Config) -> Result<R, String> + Send,
        E: FnOnce(&Config, &Config) -> Result<(), String> + Send,
        U: FnOnce(&Config, &Config) -> Result<(), String> + Send,
    {
        let _write_guard = self.writes.lock().await;
        let current = {
            let state = self.state.lock().await;
            state.config.clone()
        };
        let mut next = current.clone();
        let value = mutate(&mut next)?;

        if next == current {
            return Ok(SettingsCommit {
                value,
                changed: false,
                snapshot: self.snapshot().await,
            });
        }

        if let Err(effect_error) = apply_effect(&current, &next) {
            return match rollback_effect(&current, &next) {
                Ok(()) => Err(effect_error),
                Err(rollback_error) => Err(format!(
                    "{effect_error}; 시스템 상태 변경 실패 후 복구도 실패했습니다: {rollback_error}"
                )),
            };
        }
        if let Err(save_error) = self.persist(next.clone()).await {
            return match rollback_effect(&current, &next) {
                Ok(()) => Err(save_error),
                Err(rollback_error) => Err(format!(
                    "{save_error}; 저장 실패 후 시스템 상태 복구도 실패했습니다: {rollback_error}"
                )),
            };
        }

        let snapshot = {
            let mut state = self.state.lock().await;
            if state.config != current {
                log::error!(
                    "[settings] 직렬화 경계를 우회한 config 변경을 감지했습니다; 디스크 snapshot으로 재동기화합니다"
                );
            }
            state.config = next;
            state.settings_revision = state.settings_revision.saturating_add(1);
            state.settings_source = source.to_string();
            state.notify_scheduler();
            SettingsSnapshot::from_state(&state, &self.app_version)
        };

        Ok(SettingsCommit {
            value,
            changed: true,
            snapshot,
        })
    }

    pub async fn update_config<R, F>(
        &self,
        app: &tauri::AppHandle,
        source: &str,
        mutate: F,
    ) -> Result<SettingsCommit<R>, String>
    where
        R: Send,
        F: FnOnce(&mut Config) -> Result<R, String> + Send,
    {
        let commit = self.commit_config(source, mutate).await?;
        if commit.changed {
            emit_settings_snapshot(app, &commit.snapshot);
        }
        Ok(commit)
    }

    pub async fn update_config_with_effect<R, F, E, U>(
        &self,
        app: &tauri::AppHandle,
        source: &str,
        mutate: F,
        apply_effect: E,
        rollback_effect: U,
    ) -> Result<SettingsCommit<R>, String>
    where
        R: Send,
        F: FnOnce(&mut Config) -> Result<R, String> + Send,
        E: FnOnce(&Config, &Config) -> Result<(), String> + Send,
        U: FnOnce(&Config, &Config) -> Result<(), String> + Send,
    {
        let commit = self
            .commit_config_with_effect(source, mutate, apply_effect, rollback_effect)
            .await?;
        if commit.changed {
            emit_settings_snapshot(app, &commit.snapshot);
        }
        Ok(commit)
    }

    pub async fn set_pending_update(
        &self,
        app: &tauri::AppHandle,
        pending_version: Option<String>,
    ) -> SettingsSnapshot {
        let (changed, snapshot) = {
            let mut state = self.state.lock().await;
            let changed = state.pending_update != pending_version;
            if changed {
                state.pending_update = pending_version;
                state.settings_revision = state.settings_revision.saturating_add(1);
                state.settings_source = "updater".into();
            }
            (changed, SettingsSnapshot::from_state(&state, &self.app_version))
        };
        if changed {
            emit_settings_snapshot(app, &snapshot);
        }
        snapshot
    }

    pub async fn resolve_cohort_options(
        &self,
        app: &tauri::AppHandle,
        mut options: Vec<CohortOption>,
        today: chrono::NaiveDate,
    ) -> CohortResolution {
        options.sort_by(|left, right| {
            right
                .start_date
                .cmp(&left.start_date)
                .then_with(|| right.end_date.cmp(&left.end_date))
        });
        let (changed, resolution, snapshot) = {
            let mut state = self.state.lock().await;
            let resolution =
                attendance::resolve_cohort_selection(&options, state.config.selected_cohort_id.as_deref(), today);
            let changed = state.cohort_options != options || state.effective_cohort_id != resolution.cohort_id;
            if changed {
                state.cohort_options = options;
                state.effective_cohort_id = resolution.cohort_id.clone();
                state.settings_revision = state.settings_revision.saturating_add(1);
                state.settings_source = "checker_cohorts".into();
            }
            (
                changed,
                resolution,
                SettingsSnapshot::from_state(&state, &self.app_version),
            )
        };
        if changed {
            log::info!(
                "[checker] cohorts resolved: count={} mode={} status={:?} end_date={}",
                snapshot.cohort_options.len(),
                if snapshot.selected_cohort_id.is_some() {
                    "manual"
                } else {
                    "auto"
                },
                resolution.cohort_status,
                if resolution.cohort_end_date.is_some() {
                    "known"
                } else {
                    "missing"
                },
            );
            emit_settings_snapshot(app, &snapshot);
        }
        resolution
    }
}

pub fn emit_settings_snapshot(app: &tauri::AppHandle, snapshot: &SettingsSnapshot) {
    for label in SETTINGS_WINDOW_LABELS {
        if let Err(error) = app.emit_to(label, SETTINGS_CHANGED_EVENT, snapshot) {
            log::debug!("[settings] {label} snapshot emit skipped: {error}");
        }
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Arc;

    use tokio::sync::Mutex;

    use super::*;
    use crate::config::Config;
    use crate::state::AppState;

    static NEXT_TEST_DIRECTORY: AtomicU64 = AtomicU64::new(0);

    fn test_path(name: &str) -> std::path::PathBuf {
        let sequence = NEXT_TEST_DIRECTORY.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!("jungle-bell-settings-{name}-{}-{sequence}", std::process::id()))
    }

    #[test]
    fn failed_persistence_keeps_memory_and_revision_unchanged() {
        let root = test_path("failure");
        let blocked_parent = root.join("not-a-directory");
        fs::create_dir_all(&root).unwrap();
        fs::write(&blocked_parent, b"file").unwrap();

        let state = Arc::new(Mutex::new(AppState::new(Config::default())));
        let service =
            SettingsService::with_path(state.clone(), Some(blocked_parent.join("config.json")), "0.4.4".into());

        let result = tauri::async_runtime::block_on(service.commit_config("settings", |config| {
            config.auto_update = false;
            Ok(())
        }));

        assert!(result.is_err());
        let state = state.try_lock().unwrap();
        assert!(state.config.auto_update);
        assert_eq!(state.settings_revision, 0);
        drop(state);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn failed_persistence_rolls_back_prepared_system_effects() {
        let root = test_path("effect-rollback");
        let blocked_parent = root.join("not-a-directory");
        fs::create_dir_all(&root).unwrap();
        fs::write(&blocked_parent, b"file").unwrap();

        let state = Arc::new(Mutex::new(AppState::new(Config::default())));
        let service = SettingsService::with_path(state, Some(blocked_parent.join("config.json")), "0.4.4".into());
        let effects = Arc::new(std::sync::Mutex::new(Vec::new()));
        let apply_effects = effects.clone();
        let rollback_effects = effects.clone();

        let result = tauri::async_runtime::block_on(service.commit_config_with_effect(
            "settings",
            |config| {
                config.show_app_icon = false;
                Ok(())
            },
            move |_, _| {
                apply_effects.lock().unwrap().push("apply");
                Ok(())
            },
            move |_, _| {
                rollback_effects.lock().unwrap().push("rollback");
                Ok(())
            },
        ));

        assert!(result.is_err());
        assert_eq!(*effects.lock().unwrap(), ["apply", "rollback"]);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn failed_system_effect_is_rolled_back_before_persistence() {
        let root = test_path("effect-failure");
        let path = root.join("config.json");
        let state = Arc::new(Mutex::new(AppState::new(Config::default())));
        let service = SettingsService::with_path(state.clone(), Some(path.clone()), "0.4.4".into());
        let effects = Arc::new(std::sync::Mutex::new(Vec::new()));
        let apply_effects = effects.clone();
        let rollback_effects = effects.clone();

        let result = tauri::async_runtime::block_on(service.commit_config_with_effect(
            "settings",
            |config| {
                config.show_app_icon = false;
                Ok(())
            },
            move |_, _| {
                apply_effects.lock().unwrap().push("apply");
                Err("system effect failed".into())
            },
            move |_, _| {
                rollback_effects.lock().unwrap().push("rollback");
                Ok(())
            },
        ));

        assert!(result.is_err());
        assert_eq!(*effects.lock().unwrap(), ["apply", "rollback"]);
        assert!(!path.exists());
        let state = state.try_lock().unwrap();
        assert!(state.config.show_app_icon);
        assert_eq!(state.settings_revision, 0);
    }

    #[test]
    fn successful_persistence_updates_disk_memory_and_revision_together() {
        let root = test_path("success");
        let path = root.join("config.json");
        let state = Arc::new(Mutex::new(AppState::new(Config::default())));
        let service = SettingsService::with_path(state.clone(), Some(path.clone()), "0.4.4".into());

        let commit = tauri::async_runtime::block_on(service.commit_config("settings", |config| {
            config.auto_update = false;
            Ok(())
        }))
        .unwrap();

        assert!(commit.changed);
        assert_eq!(commit.snapshot.revision, 1);
        assert_eq!(commit.snapshot.source, "settings");
        assert!(!commit.snapshot.auto_update);

        let persisted: Config = serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
        assert!(!persisted.auto_update);
        let state = state.try_lock().unwrap();
        assert!(!state.config.auto_update);
        assert_eq!(state.settings_revision, 1);
        drop(state);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn snapshot_exposes_ui_settings_but_not_internal_config_fields() {
        let state = Arc::new(Mutex::new(AppState::new(Config {
            onboarding_completed: true,
            welcome_notification_sent: true,
            last_version: Some("0.4.3".into()),
            ..Config::default()
        })));
        let service = SettingsService::with_path(state, None, "0.4.4".into());

        let snapshot = tauri::async_runtime::block_on(service.snapshot());
        let value = serde_json::to_value(snapshot).unwrap();
        let object = value.as_object().unwrap();

        assert_eq!(object.get("appVersion").unwrap(), "0.4.4");
        assert!(object.contains_key("autoStart"));
        assert!(object.contains_key("notificationStart"));
        assert_eq!(object.get("notificationDelivery").unwrap(), "both");
        assert!(!object.contains_key("onboardingCompleted"));
        assert!(!object.contains_key("welcomeNotificationSent"));
        assert!(!object.contains_key("lastVersion"));
        assert!(!object.contains_key("morningStart"));
    }
}
