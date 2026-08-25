use std::path::PathBuf;
use std::sync::Arc;

use tokio::sync::Mutex;

use crate::attendance::{self, CohortOption, CohortResolution};
use crate::config::{self, Config};
use crate::state::AppState;

pub struct DesktopSettingsSnapshot {
    pub config: Config,
    pub cohort_options: Vec<CohortOption>,
    pub effective_cohort_id: Option<String>,
}

/// 이 PC에 적용할 설정과 서버에 동기화할 통계 선택을 원자적으로 저장한다.
pub struct DesktopSettingsService {
    state: Arc<Mutex<AppState>>,
    path: Option<PathBuf>,
    writes: Mutex<()>,
}

impl DesktopSettingsService {
    pub fn new(state: Arc<Mutex<AppState>>) -> Self {
        Self::with_path(state, config::config_path())
    }

    fn with_path(state: Arc<Mutex<AppState>>, path: Option<PathBuf>) -> Self {
        Self {
            state,
            path,
            writes: Mutex::new(()),
        }
    }

    pub async fn settings(&self) -> Config {
        self.state.lock().await.config.clone()
    }

    pub async fn snapshot(&self) -> DesktopSettingsSnapshot {
        let state = self.state.lock().await;
        DesktopSettingsSnapshot {
            config: state.config.clone(),
            cohort_options: state.cohort_options.clone(),
            effective_cohort_id: state.effective_cohort_id.clone(),
        }
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

    /// 앱 설치 상태를 확인한 뒤에만 확정할 수 있는 통계 기본값을 저장한다.
    /// 저장 실패 시 메모리의 fail-closed 값은 바꾸지 않는다.
    pub async fn initialize_usage_analytics(&self, desired: Option<bool>) -> Result<Config, String> {
        let _write_guard = self.writes.lock().await;
        let current = self.state.lock().await.config.clone();
        if current.usage_analytics == desired {
            return Ok(current);
        }
        let mut next = current;
        next.usage_analytics = desired;
        self.persist(next.clone()).await?;
        let mut state = self.state.lock().await;
        state.config = next.clone();
        state.notify_scheduler();
        Ok(next)
    }

    /// 로컬에 명시적 선택이 없을 때만 계정 설정을 원자적으로 채택한다.
    pub async fn adopt_usage_analytics_if_undecided(&self, enabled: bool) -> Result<bool, String> {
        let _write_guard = self.writes.lock().await;
        let current = self.state.lock().await.config.clone();
        if current.usage_analytics.is_some() {
            return Ok(false);
        }
        let mut next = current;
        next.usage_analytics = Some(enabled);
        self.persist(next.clone()).await?;
        let mut state = self.state.lock().await;
        if state.config.usage_analytics.is_some() {
            return Ok(false);
        }
        state.config = next;
        state.notify_scheduler();
        Ok(true)
    }

    /// OS 자동 시작 상태와 설정 파일을 함께 변경한다. 저장 실패 시 OS 상태를
    /// 원래 값으로 되돌리고 메모리 상태는 변경하지 않는다.
    pub async fn update(&self, app: &tauri::AppHandle, next: Config) -> Result<Config, String> {
        config::validate_selected_cohort_id(next.selected_cohort_id.as_deref())?;
        let _write_guard = self.writes.lock().await;
        let current = self.state.lock().await.config.clone();
        if current == next {
            return Ok(next);
        }

        if current.auto_start != next.auto_start {
            crate::autostart::sync_auto_start(app, next.auto_start)?;
        }
        if let Err(save_error) = self.persist(next.clone()).await {
            if current.auto_start != next.auto_start {
                return match crate::autostart::sync_auto_start(app, current.auto_start) {
                    Ok(()) => Err(save_error),
                    Err(rollback_error) => Err(format!(
                        "{save_error}; 자동 시작 상태 복구도 실패했습니다: {rollback_error}"
                    )),
                };
            }
            return Err(save_error);
        }

        let mut state = self.state.lock().await;
        state.config = next.clone();
        if !state.cohort_options.is_empty() {
            let resolution = attendance::resolve_cohort(
                &state.cohort_options,
                state.config.selected_cohort_id.as_deref(),
                chrono::Utc::now().with_timezone(&crate::state::kst()).date_naive(),
            );
            state.effective_cohort_id = resolution.cohort_id;
        }
        state.notify_scheduler();
        Ok(next)
    }

    /// 저장된 기수를 우선 적용하고, 선택이 없거나 목록에 없으면 현재 날짜에
    /// 맞는 기수를 자동으로 선택한다.
    pub async fn resolve_cohort_options(
        &self,
        mut options: Vec<CohortOption>,
        today: chrono::NaiveDate,
    ) -> CohortResolution {
        options.sort_by(|left, right| {
            right
                .start_date
                .cmp(&left.start_date)
                .then_with(|| right.end_date.cmp(&left.end_date))
        });
        let mut state = self.state.lock().await;
        let resolution = attendance::resolve_cohort(&options, state.config.selected_cohort_id.as_deref(), today);
        state.cohort_options = options;
        state.effective_cohort_id = resolution.cohort_id.clone();
        state.notify_scheduler();
        resolution
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    fn test_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "jungle-bell-desktop-settings-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[test]
    fn 설정_읽기는_데스크톱_서비스_항목을_노출한다() {
        let expected = Config {
            auto_start: true,
            auto_update: false,
            usage_analytics: Some(false),
            debug_mode: true,
            selected_cohort_id: None,
        };
        let state = Arc::new(Mutex::new(AppState::new(expected.clone())));
        let service = DesktopSettingsService::with_path(state, None);
        assert_eq!(tauri::async_runtime::block_on(service.settings()), expected);
    }

    #[test]
    fn 저장_실패시_메모리_설정을_바꾸지_않는다() {
        let root = test_path("failure");
        let blocked_parent = root.join("not-a-directory");
        fs::create_dir_all(&root).unwrap();
        fs::write(&blocked_parent, b"file").unwrap();
        let state = Arc::new(Mutex::new(AppState::new(Config::default())));
        let service = DesktopSettingsService::with_path(state.clone(), Some(blocked_parent.join("settings.json")));

        let next = Config {
            auto_start: true,
            ..Config::default()
        };
        assert!(tauri::async_runtime::block_on(service.persist(next)).is_err());
        assert!(!state.try_lock().unwrap().config.auto_start);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn clean_new_통계_기본값은_저장에_성공한_뒤에만_적용한다() {
        let path = test_path("clean-new-usage");
        let state = Arc::new(Mutex::new(AppState::new(Config::default())));
        let service = DesktopSettingsService::with_path(state.clone(), Some(path.clone()));

        let saved = tauri::async_runtime::block_on(service.initialize_usage_analytics(Some(true))).unwrap();

        assert_eq!(saved.usage_analytics, Some(true));
        assert_eq!(state.try_lock().unwrap().config.usage_analytics, Some(true));
        let reloaded = Config::load_from(&path);
        assert_eq!(reloaded.config.usage_analytics, Some(true));
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn 서버의_명시적_선택은_undecided일_때만_채택한다() {
        let path = test_path("remote-usage");
        let state = Arc::new(Mutex::new(AppState::new(Config::default())));
        let service = DesktopSettingsService::with_path(state.clone(), Some(path.clone()));

        assert!(tauri::async_runtime::block_on(service.adopt_usage_analytics_if_undecided(false)).unwrap());
        assert_eq!(state.try_lock().unwrap().config.usage_analytics, Some(false));
        assert!(!tauri::async_runtime::block_on(service.adopt_usage_analytics_if_undecided(true)).unwrap());
        assert_eq!(state.try_lock().unwrap().config.usage_analytics, Some(false));
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn 기수_선택은_로컬_설정없이_현재_기수를_자동_선택한다() {
        let state = Arc::new(Mutex::new(AppState::new(Config::default())));
        let service = DesktopSettingsService::with_path(state.clone(), None);
        let options = vec![CohortOption {
            id: "cohort-1".into(),
            label: "1기".into(),
            start_date: chrono::NaiveDate::from_ymd_opt(2026, 8, 1).unwrap(),
            end_date: Some(chrono::NaiveDate::from_ymd_opt(2026, 8, 31).unwrap()),
            is_active: true,
        }];

        let resolution = tauri::async_runtime::block_on(
            service.resolve_cohort_options(options, chrono::NaiveDate::from_ymd_opt(2026, 8, 10).unwrap()),
        );
        assert_eq!(resolution.cohort_id.as_deref(), Some("cohort-1"));
        assert_eq!(
            state.try_lock().unwrap().effective_cohort_id.as_deref(),
            Some("cohort-1")
        );
    }

    #[test]
    fn 저장한_기수는_자동_선택보다_우선한다() {
        let state = Arc::new(Mutex::new(AppState::new(Config {
            selected_cohort_id: Some("cohort-2".into()),
            ..Config::default()
        })));
        let service = DesktopSettingsService::with_path(state.clone(), None);
        let options = vec![
            CohortOption {
                id: "cohort-1".into(),
                label: "1기".into(),
                start_date: chrono::NaiveDate::from_ymd_opt(2026, 8, 1).unwrap(),
                end_date: Some(chrono::NaiveDate::from_ymd_opt(2026, 8, 31).unwrap()),
                is_active: true,
            },
            CohortOption {
                id: "cohort-2".into(),
                label: "2기".into(),
                start_date: chrono::NaiveDate::from_ymd_opt(2026, 7, 1).unwrap(),
                end_date: Some(chrono::NaiveDate::from_ymd_opt(2026, 12, 31).unwrap()),
                is_active: true,
            },
        ];

        let resolution = tauri::async_runtime::block_on(
            service.resolve_cohort_options(options, chrono::NaiveDate::from_ymd_opt(2026, 8, 10).unwrap()),
        );
        assert_eq!(resolution.cohort_id.as_deref(), Some("cohort-2"));
        assert_eq!(
            state.try_lock().unwrap().effective_cohort_id.as_deref(),
            Some("cohort-2")
        );
    }
}
