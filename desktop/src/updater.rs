//! 서명된 GitHub Release를 확인하고 안전한 시점에 설치한다.

use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, AtomicU8, Ordering},
        Arc, RwLock,
    },
    time::Duration,
};

use semver::Version;
use serde::{Deserialize, Serialize};
use tauri::Manager;
use tauri_plugin_updater::{Error as UpdaterError, Update, UpdaterExt};
use tokio::sync::Mutex;

use crate::{
    config::write_file_atomically,
    desktop_settings::DesktopSettingsService,
    notification_service::{NotificationRequest, NotificationService},
};

const UPDATE_CHECK_TIMEOUT: Duration = Duration::from_secs(10);
const UPDATE_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(30);
const PENDING_UPDATE_FILE: &str = "pending-update.json";
const PENDING_UPDATE_SCHEMA_VERSION: u8 = 1;
const MAX_AUTO_INSTALL_ATTEMPTS: u8 = 3;
const AUTO_INSTALL_RETRY_BACKOFF_SECS: i64 = 60 * 60;
const SESSION_BACKGROUND: u8 = 0;
const SESSION_FOREGROUND: u8 = 1;
const SESSION_INSTALLING: u8 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum DesktopUpdateStage {
    Checking,
    Latest,
    Optional,
    Mandatory,
    Downloading,
    Verifying,
    Installing,
    RestartRequired,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum DesktopUpdatePolicy {
    Optional,
    Mandatory,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopUpdateProgress {
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopUpdateStatus {
    current_version: String,
    available_version: Option<String>,
    status: DesktopUpdateStage,
    policy: Option<DesktopUpdatePolicy>,
    progress: Option<DesktopUpdateProgress>,
    error_code: Option<String>,
}

impl DesktopUpdateStatus {
    fn new(current_version: impl Into<String>, available_version: Option<String>) -> Self {
        let current_version = current_version.into();
        let policy = current_version
            .parse::<Version>()
            .ok()
            .zip(
                available_version
                    .as_deref()
                    .and_then(|version| version.parse::<Version>().ok()),
            )
            .map(|(current, available)| {
                if is_mandatory_update(&current, &available) {
                    DesktopUpdatePolicy::Mandatory
                } else {
                    DesktopUpdatePolicy::Optional
                }
            });
        let status = match policy {
            Some(DesktopUpdatePolicy::Mandatory) => DesktopUpdateStage::Mandatory,
            Some(DesktopUpdatePolicy::Optional) => DesktopUpdateStage::Optional,
            None => DesktopUpdateStage::Latest,
        };
        Self {
            current_version,
            available_version,
            status,
            policy,
            progress: None,
            error_code: None,
        }
    }

    fn checking(current_version: impl Into<String>) -> Self {
        Self {
            current_version: current_version.into(),
            available_version: None,
            status: DesktopUpdateStage::Checking,
            policy: None,
            progress: None,
            error_code: None,
        }
    }

    fn checking_from(mut self, current_version: impl Into<String>) -> Self {
        self.current_version = current_version.into();
        self.status = DesktopUpdateStage::Checking;
        self.progress = None;
        self.error_code = None;
        self
    }

    fn with_stage(mut self, status: DesktopUpdateStage, progress: Option<DesktopUpdateProgress>) -> Self {
        self.status = status;
        self.progress = progress;
        self.error_code = None;
        self
    }

    fn failed(mut self, error_code: impl Into<String>) -> Self {
        self.status = DesktopUpdateStage::Failed;
        self.error_code = Some(error_code.into());
        self
    }

    fn with_progress(mut self, progress: DesktopUpdateProgress) -> Self {
        self.progress = Some(progress);
        self
    }
}

fn is_mandatory_update(current: &Version, available: &Version) -> bool {
    available.pre.is_empty()
        && available.build.is_empty()
        && (available.major, available.minor) > (current.major, current.minor)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PendingUpdateMarker {
    schema_version: u8,
    version: String,
    auto_install_attempts: u8,
    #[serde(default)]
    retry_not_before_unix_seconds: i64,
}

impl PendingUpdateMarker {
    fn for_version(previous: Option<&Self>, version: &str) -> Self {
        let previous = previous.filter(|marker| marker.version == version);
        Self {
            schema_version: PENDING_UPDATE_SCHEMA_VERSION,
            version: version.to_owned(),
            auto_install_attempts: previous.map_or(0, |marker| marker.auto_install_attempts),
            retry_not_before_unix_seconds: previous.map_or(0, |marker| marker.retry_not_before_unix_seconds),
        }
    }

    fn can_attempt_auto_install(&self) -> bool {
        self.can_attempt_auto_install_at(chrono::Utc::now().timestamp())
    }

    fn can_attempt_auto_install_at(&self, now_unix_seconds: i64) -> bool {
        self.auto_install_attempts < MAX_AUTO_INSTALL_ATTEMPTS && self.retry_not_before_unix_seconds <= now_unix_seconds
    }

    fn record_auto_install_attempt(&mut self) {
        self.auto_install_attempts = self.auto_install_attempts.saturating_add(1);
        self.retry_not_before_unix_seconds = 0;
    }

    fn defer_auto_install(&mut self, now_unix_seconds: i64) {
        self.retry_not_before_unix_seconds = now_unix_seconds.saturating_add(AUTO_INSTALL_RETRY_BACKOFF_SECS);
    }
}

struct CachedUpdateCheck {
    status: DesktopUpdateStatus,
    update: Option<Update>,
}

#[derive(Default)]
struct UpdateOperationState {
    cached: Option<CachedUpdateCheck>,
    pending: Option<PendingUpdateMarker>,
}

impl UpdateOperationState {
    fn cached_check(&self) -> Option<Result<CheckedUpdate, String>> {
        self.cached.as_ref().map(|cached| {
            Ok(CheckedUpdate {
                status: cached.status.clone(),
                update: cached.update.clone(),
            })
        })
    }

    fn remember_failure(&mut self, error_code: &str) -> bool {
        let Some(cached) = self.cached.as_mut() else {
            return false;
        };
        cached.status = cached.status.clone().failed(error_code);
        true
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AutoUpdateOutcome {
    Current,
    Deferred,
    Failed,
    RestartRequested,
}

/// 업데이트 확인, 유예 상태, 설치 직전 안전 판정을 하나의 직렬화 경계에서 관리한다.
pub(crate) struct UpdateCoordinator {
    operation: Mutex<UpdateOperationState>,
    status_snapshot: RwLock<DesktopUpdateStatus>,
    session_state: AtomicU8,
    marker_path: PathBuf,
}

impl UpdateCoordinator {
    pub(crate) fn new(app: &tauri::AppHandle) -> tauri::Result<Self> {
        let marker_path = app.path().app_data_dir()?.join(PENDING_UPDATE_FILE);
        let current_version = app.package_info().version.clone();
        let pending = load_pending_marker(&marker_path, &current_version);
        let initial_status = pending.as_ref().map_or_else(
            || DesktopUpdateStatus::checking(current_version.to_string()),
            |marker| DesktopUpdateStatus::new(current_version.to_string(), Some(marker.version.clone())),
        );
        Ok(Self {
            operation: Mutex::new(UpdateOperationState { cached: None, pending }),
            status_snapshot: RwLock::new(initial_status),
            session_state: AtomicU8::new(SESSION_BACKGROUND),
            marker_path,
        })
    }

    pub(crate) fn mark_foreground_seen(&self) -> bool {
        loop {
            match self.session_state.load(Ordering::Acquire) {
                SESSION_FOREGROUND => return true,
                SESSION_INSTALLING => return false,
                SESSION_BACKGROUND => {
                    if self
                        .session_state
                        .compare_exchange(
                            SESSION_BACKGROUND,
                            SESSION_FOREGROUND,
                            Ordering::AcqRel,
                            Ordering::Acquire,
                        )
                        .is_ok()
                    {
                        return true;
                    }
                }
                _ => return false,
            }
        }
    }

    fn try_begin_auto_install(&self) -> bool {
        self.session_state
            .compare_exchange(
                SESSION_BACKGROUND,
                SESSION_INSTALLING,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .is_ok()
    }

    fn try_begin_manual_install(&self) -> bool {
        self.mark_foreground_seen()
            && self
                .session_state
                .compare_exchange(
                    SESSION_FOREGROUND,
                    SESSION_INSTALLING,
                    Ordering::AcqRel,
                    Ordering::Acquire,
                )
                .is_ok()
    }

    fn status_snapshot(&self) -> DesktopUpdateStatus {
        self.status_snapshot
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    fn publish_status(&self, status: DesktopUpdateStatus) {
        *self
            .status_snapshot
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = status;
    }

    fn remember_status(&self, state: &mut UpdateOperationState, status: DesktopUpdateStatus) {
        if let Some(cached) = state.cached.as_mut() {
            cached.status = status.clone();
        }
        self.publish_status(status);
    }

    fn remember_failure(&self, state: &mut UpdateOperationState, current_version: &str, error_code: &str) {
        let status = if state.remember_failure(error_code) {
            state.cached.as_ref().unwrap().status.clone()
        } else {
            self.status_snapshot().checking_from(current_version).failed(error_code)
        };
        if state.cached.is_none() && status.available_version.is_some() {
            state.cached = Some(CachedUpdateCheck {
                status: status.clone(),
                update: None,
            });
        }
        self.publish_status(status);
    }

    pub(crate) async fn has_pending_auto_install(&self) -> bool {
        self.operation
            .lock()
            .await
            .pending
            .as_ref()
            .is_some_and(PendingUpdateMarker::can_attempt_auto_install)
    }

    pub(crate) async fn check_update(&self, app: &tauri::AppHandle) -> Result<DesktopUpdateStatus, String> {
        if self.session_state.load(Ordering::Acquire) == SESSION_INSTALLING {
            return Ok(self.status_snapshot());
        }
        let mut state = self.operation.lock().await;
        let checked = self.check_remote(app, &mut state, false).await?;
        Ok(checked.status)
    }

    pub(crate) async fn refresh_update(&self, app: &tauri::AppHandle) -> Result<DesktopUpdateStatus, String> {
        if self.session_state.load(Ordering::Acquire) == SESSION_INSTALLING {
            return Ok(self.status_snapshot());
        }
        let mut state = self.operation.lock().await;
        let checked = self.check_remote(app, &mut state, true).await?;
        Ok(checked.status)
    }

    pub(crate) async fn install_update(&self, app: tauri::AppHandle) -> Result<(), String> {
        if !self.try_begin_manual_install() {
            return Err("UPDATE_INSTALL_IN_PROGRESS".to_owned());
        }
        let result = self.install_foreground_update(app).await;
        if !matches!(result, Ok(true)) {
            self.session_state.store(SESSION_FOREGROUND, Ordering::Release);
        }
        result.map(|_| ())
    }

    async fn install_foreground_update(&self, app: tauri::AppHandle) -> Result<bool, String> {
        let mut state = self.operation.lock().await;
        let checked = self.check_remote(&app, &mut state, true).await?;
        let Some(update) = checked.update else {
            log::debug!("[updater] 최신 버전");
            return Ok(false);
        };

        // Windows installer는 install 호출 안에서 프로세스를 종료할 수 있다.
        // 사용자가 막 변경한 설정이 디스크에 반영된 뒤 설치를 시작하고, 설치가
        // 끝나거나 실패할 때까지 새 설정 저장도 시작하지 못하게 한다.
        let settings: tauri::State<Arc<DesktopSettingsService>> = app.state();
        let _settings_write_guard = settings.lock_writes_for_update().await;

        // 수동 설치는 자동 재시도 상한을 소비하지 않는다. 실패 후 다음 실행에서
        // 다시 안내할 수 있도록 pending version만 확정한다.
        if let Err(error) = self.persist_pending_version(&mut state, &update.version) {
            log::warn!("[updater] 수동 설치 marker 기록 실패: {error}");
        }
        let (bytes, progress) = match self.download_verified_update(&checked.status, &update).await {
            Ok(download) => download,
            Err(error) => {
                let error_code = updater_operation_error_code(&error);
                log::error!("[updater] 업데이트 다운로드 또는 서명 검증 실패: {error}");
                let failed = self.status_snapshot().failed(error_code);
                self.remember_status(&mut state, failed);
                self.defer_pending_retry(&mut state);
                return Err(error_code.to_owned());
            }
        };
        self.notify_installing(&app, &update.version);
        self.remember_status(
            &mut state,
            checked
                .status
                .clone()
                .with_stage(DesktopUpdateStage::Installing, Some(progress.clone())),
        );
        if let Err(error) = update.install(bytes) {
            log::error!("[updater] 업데이트 설치 실패: {error}");
            self.remember_status(
                &mut state,
                checked.status.failed("UPDATE_INSTALL_FAILED").with_progress(progress),
            );
            self.defer_pending_retry(&mut state);
            return Err("UPDATE_INSTALL_FAILED".to_owned());
        }
        self.remember_status(
            &mut state,
            checked
                .status
                .with_stage(DesktopUpdateStage::RestartRequired, Some(progress)),
        );
        app.request_restart();
        Ok(true)
    }

    pub(crate) async fn apply_pending_update_on_start(&self, app: tauri::AppHandle) -> AutoUpdateOutcome {
        let mut state = self.operation.lock().await;
        if !state
            .pending
            .as_ref()
            .is_some_and(PendingUpdateMarker::can_attempt_auto_install)
        {
            return AutoUpdateOutcome::Deferred;
        }
        let checked = match self.check_remote(&app, &mut state, true).await {
            Ok(checked) => checked,
            Err(error) => {
                log::warn!("[updater] 자동 업데이트 확인 중단: {error}");
                return AutoUpdateOutcome::Failed;
            }
        };
        let Some(update) = checked.update else {
            return AutoUpdateOutcome::Current;
        };

        if !self.is_startup_preflight_safe(&app) {
            log::info!(
                "[updater] 사용자 세션을 감지해 v{} 설치를 다음 실행으로 유예",
                update.version
            );
            return AutoUpdateOutcome::Deferred;
        }

        let marker_can_retry = state
            .pending
            .as_ref()
            .filter(|marker| marker.version == update.version)
            .is_some_and(PendingUpdateMarker::can_attempt_auto_install);
        if !marker_can_retry {
            log::warn!(
                "[updater] v{} 자동 설치 시도 상한({MAX_AUTO_INSTALL_ATTEMPTS})에 도달해 수동 설치로 유예",
                update.version,
            );
            return AutoUpdateOutcome::Deferred;
        }
        log::info!("[updater] v{} 서명 검증 다운로드 시작", update.version);
        let (bytes, progress) = match self.download_verified_update(&checked.status, &update).await {
            Ok(download) => download,
            Err(error) => {
                log::error!("[updater] 업데이트 다운로드 또는 서명 검증 실패: {error}");
                let error_code = updater_operation_error_code(&error);
                let failed = self.status_snapshot().failed(error_code);
                self.remember_status(&mut state, failed);
                self.defer_pending_retry(&mut state);
                return AutoUpdateOutcome::Failed;
            }
        };

        // 다운로드 중 창이 열릴 수 있으므로 설치 직전에 다시 판정한다. CAS가
        // 성공한 뒤에는 창 열기 경로가 설치 완료 전까지 새 UI를 만들지 않는다.
        if !self.is_startup_preflight_safe(&app) || !self.try_begin_auto_install() {
            log::info!(
                "[updater] 다운로드 중 사용자 세션이 시작되어 v{} 설치를 유예",
                update.version
            );
            self.remember_status(&mut state, checked.status);
            return AutoUpdateOutcome::Deferred;
        }

        if let Err(error) = self.record_install_attempt(&mut state, &update.version) {
            self.session_state.store(SESSION_BACKGROUND, Ordering::Release);
            log::warn!("[updater] 자동 설치 marker 기록 실패로 설치를 유예: {error}");
            let failed = checked.status.failed("UPDATE_STATE_SAVE_FAILED");
            self.remember_status(&mut state, failed);
            return AutoUpdateOutcome::Failed;
        }

        self.remember_status(
            &mut state,
            checked
                .status
                .clone()
                .with_stage(DesktopUpdateStage::Installing, Some(progress.clone())),
        );
        if let Err(error) = update.install(bytes) {
            self.session_state.store(SESSION_BACKGROUND, Ordering::Release);
            log::error!("[updater] 업데이트 설치 실패: {error}");
            self.remember_status(
                &mut state,
                checked.status.failed("UPDATE_INSTALL_FAILED").with_progress(progress),
            );
            self.defer_pending_retry(&mut state);
            return AutoUpdateOutcome::Failed;
        }

        // Windows updater는 install 안에서 상태 정리 hook 실행 후 프로세스를
        // 종료한다. install이 반환되는 플랫폼은 이벤트 루프에 재시작을 요청한다.
        self.remember_status(
            &mut state,
            checked
                .status
                .with_stage(DesktopUpdateStage::RestartRequired, Some(progress)),
        );
        app.request_restart();
        AutoUpdateOutcome::RestartRequested
    }

    async fn check_remote(
        &self,
        app: &tauri::AppHandle,
        state: &mut UpdateOperationState,
        force: bool,
    ) -> Result<CheckedUpdate, String> {
        if !force {
            if let Some(cached) = state.cached_check() {
                if let Ok(checked) = &cached {
                    self.publish_status(checked.status.clone());
                }
                return cached;
            }
        }

        let current_version = app.package_info().version.to_string();
        self.publish_status(self.status_snapshot().checking_from(current_version.clone()));

        let updater = match app.updater_builder().timeout(UPDATE_CHECK_TIMEOUT).build() {
            Ok(updater) => updater,
            Err(error) => {
                log::debug!("[updater] updater 초기화 실패: {error}");
                let error = "UPDATER_UNAVAILABLE".to_owned();
                self.remember_failure(state, &current_version, &error);
                self.defer_pending_retry(state);
                return Err(error);
            }
        };
        let mut update = match updater.check().await {
            Ok(update) => update,
            Err(error) => {
                log::warn!("[updater] 업데이트 확인 실패: {error}");
                let error = "UPDATE_CHECK_FAILED".to_owned();
                self.remember_failure(state, &current_version, &error);
                self.defer_pending_retry(state);
                return Err(error);
            }
        };
        if let Some(update) = update.as_mut() {
            update.timeout = Some(UPDATE_DOWNLOAD_TIMEOUT);
        }
        let status = DesktopUpdateStatus::new(current_version, update.as_ref().map(|update| update.version.clone()));

        match update.as_ref() {
            Some(update) => {
                log::info!("[updater] v{} 업데이트 사용 가능", update.version);
                if let Err(error) = self.persist_pending_version(state, &update.version) {
                    log::warn!("[updater] pending marker 저장 실패: {error}");
                }
            }
            None => {
                log::debug!("[updater] 최신 버전");
                self.clear_pending_marker(state);
            }
        }

        state.cached = Some(CachedUpdateCheck {
            status: status.clone(),
            update: update.clone(),
        });
        self.publish_status(status.clone());
        Ok(CheckedUpdate { status, update })
    }

    async fn download_verified_update(
        &self,
        status: &DesktopUpdateStatus,
        update: &Update,
    ) -> Result<(Vec<u8>, DesktopUpdateProgress), UpdaterError> {
        let downloaded_bytes = Arc::new(AtomicU64::new(0));
        let total_bytes = Arc::new(AtomicU64::new(u64::MAX));
        let initial_progress = DesktopUpdateProgress {
            downloaded_bytes: 0,
            total_bytes: None,
        };
        self.publish_status(
            status
                .clone()
                .with_stage(DesktopUpdateStage::Downloading, Some(initial_progress)),
        );

        let chunk_downloaded = downloaded_bytes.clone();
        let chunk_total = total_bytes.clone();
        let chunk_status = status.clone();
        let finish_downloaded = downloaded_bytes.clone();
        let finish_total = total_bytes.clone();
        let finish_status = status.clone();
        let bytes = update
            .download(
                |chunk_length, content_length| {
                    let downloaded = chunk_downloaded
                        .fetch_add(chunk_length as u64, Ordering::AcqRel)
                        .saturating_add(chunk_length as u64);
                    if let Some(total) = content_length {
                        chunk_total.store(total, Ordering::Release);
                    }
                    let progress = DesktopUpdateProgress {
                        downloaded_bytes: downloaded,
                        total_bytes: observed_total_bytes(&chunk_total),
                    };
                    self.publish_status(
                        chunk_status
                            .clone()
                            .with_stage(DesktopUpdateStage::Downloading, Some(progress)),
                    );
                },
                || {
                    let progress = DesktopUpdateProgress {
                        downloaded_bytes: finish_downloaded.load(Ordering::Acquire),
                        total_bytes: observed_total_bytes(&finish_total),
                    };
                    self.publish_status(finish_status.with_stage(DesktopUpdateStage::Verifying, Some(progress)));
                },
            )
            .await?;
        let progress = DesktopUpdateProgress {
            downloaded_bytes: downloaded_bytes.load(Ordering::Acquire),
            total_bytes: observed_total_bytes(&total_bytes),
        };
        Ok((bytes, progress))
    }

    fn persist_pending_version(&self, state: &mut UpdateOperationState, version: &str) -> Result<(), String> {
        let marker = PendingUpdateMarker::for_version(state.pending.as_ref(), version);
        persist_pending_marker(&self.marker_path, &marker)?;
        state.pending = Some(marker);
        Ok(())
    }

    fn record_install_attempt(&self, state: &mut UpdateOperationState, version: &str) -> Result<(), String> {
        let mut marker = PendingUpdateMarker::for_version(state.pending.as_ref(), version);
        marker.record_auto_install_attempt();
        persist_pending_marker(&self.marker_path, &marker)?;
        state.pending = Some(marker);
        Ok(())
    }

    fn defer_pending_retry(&self, state: &mut UpdateOperationState) {
        let Some(marker) = state.pending.as_mut() else {
            return;
        };
        marker.defer_auto_install(chrono::Utc::now().timestamp());
        if let Err(error) = persist_pending_marker(&self.marker_path, marker) {
            log::warn!("[updater] pending retry backoff 저장 실패: {error}");
        }
    }

    fn clear_pending_marker(&self, state: &mut UpdateOperationState) {
        state.pending = None;
        if let Err(error) = remove_pending_marker(&self.marker_path) {
            log::warn!("[updater] 오래된 pending marker 삭제 실패: {error}");
        }
    }

    fn is_startup_preflight_safe(&self, app: &tauri::AppHandle) -> bool {
        self.session_state.load(Ordering::Acquire) == SESSION_BACKGROUND
            && app.get_webview_window("dashboard").is_none()
    }

    fn notify_installing(&self, app: &tauri::AppHandle, version: &str) {
        let notifications: tauri::State<Arc<NotificationService>> = app.state();
        let key = format!("updater.installing:{version}");
        let body = format!("v{version}로 업데이트합니다. 잠시 후 재시작됩니다.");
        notifications.deliver(app, NotificationRequest::system(&key, "Jungle Bell 업데이트", &body));
    }
}

struct CheckedUpdate {
    status: DesktopUpdateStatus,
    update: Option<Update>,
}

fn observed_total_bytes(total_bytes: &AtomicU64) -> Option<u64> {
    match total_bytes.load(Ordering::Acquire) {
        u64::MAX => None,
        total => Some(total),
    }
}

fn updater_operation_error_code(error: &UpdaterError) -> &'static str {
    match error {
        UpdaterError::Minisign(_) | UpdaterError::Base64(_) | UpdaterError::SignatureUtf8(_) => "UPDATE_VERIFY_FAILED",
        _ => "UPDATE_DOWNLOAD_FAILED",
    }
}

pub(crate) fn mark_foreground_session(app: &tauri::AppHandle) -> bool {
    if let Some(coordinator) = app.try_state::<Arc<UpdateCoordinator>>() {
        coordinator.mark_foreground_seen()
    } else {
        true
    }
}

fn load_pending_marker(path: &Path, current_version: &Version) -> Option<PendingUpdateMarker> {
    let data = match fs::read(path) {
        Ok(data) => data,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
        Err(error) => {
            log::warn!("[updater] pending marker 읽기 실패: {error}");
            return None;
        }
    };
    let marker: PendingUpdateMarker = match serde_json::from_slice(&data) {
        Ok(marker) => marker,
        Err(error) => {
            log::warn!("[updater] 잘못된 pending marker 폐기: {error}");
            let _ = remove_pending_marker(path);
            return None;
        }
    };
    let pending_version = match Version::parse(&marker.version) {
        Ok(version) if marker.schema_version == PENDING_UPDATE_SCHEMA_VERSION => version,
        _ => {
            log::warn!("[updater] 지원하지 않는 pending marker 폐기");
            let _ = remove_pending_marker(path);
            return None;
        }
    };
    if pending_version <= *current_version {
        let _ = remove_pending_marker(path);
        None
    } else {
        Some(marker)
    }
}

fn persist_pending_marker(path: &Path, marker: &PendingUpdateMarker) -> Result<(), String> {
    let parent = path.parent().ok_or_else(|| "UPDATE_STATE_SAVE_FAILED".to_owned())?;
    fs::create_dir_all(parent).map_err(|error| {
        log::warn!("[updater] pending marker 디렉터리 생성 실패: {error}");
        "UPDATE_STATE_SAVE_FAILED".to_owned()
    })?;
    let data = serde_json::to_vec(marker).map_err(|error| {
        log::warn!("[updater] pending marker 직렬화 실패: {error}");
        "UPDATE_STATE_SAVE_FAILED".to_owned()
    })?;
    write_file_atomically(path, &data).map_err(|error| {
        log::warn!("[updater] pending marker atomic write 실패: {error}");
        "UPDATE_STATE_SAVE_FAILED".to_owned()
    })
}

fn remove_pending_marker(path: &Path) -> std::io::Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use semver::Version;

    #[test]
    fn 정식_minor_이상_릴리즈만_강제_업데이트한다() {
        let current = Version::parse("0.5.4").unwrap();

        assert!(!is_mandatory_update(&current, &Version::parse("0.5.5").unwrap()));
        assert!(is_mandatory_update(&current, &Version::parse("0.6.0").unwrap()));
        assert!(is_mandatory_update(&current, &Version::parse("1.0.0").unwrap()));
        assert!(!is_mandatory_update(&current, &Version::parse("0.6.0-rc.1").unwrap()));
        assert!(!is_mandatory_update(
            &current,
            &Version::parse("0.6.0+build.1").unwrap()
        ));
    }

    #[test]
    fn 업데이트_상태는_단계_policy_진행률_오류를_exact하게_노출한다() {
        let available = DesktopUpdateStatus::new("0.5.0", Some("0.5.1".to_owned()));
        let mandatory = DesktopUpdateStatus::new("0.5.0", Some("0.6.0".to_owned()));
        let current = DesktopUpdateStatus::new("0.6.0", None);
        let downloading = mandatory.clone().with_stage(
            DesktopUpdateStage::Downloading,
            Some(DesktopUpdateProgress {
                downloaded_bytes: 25,
                total_bytes: Some(100),
            }),
        );
        let failed = downloading.failed("UPDATE_VERIFY_FAILED");

        assert_eq!(
            serde_json::to_value(available).unwrap(),
            serde_json::json!({
                "currentVersion": "0.5.0",
                "availableVersion": "0.5.1",
                "status": "optional",
                "policy": "optional",
                "progress": null,
                "errorCode": null
            })
        );
        assert_eq!(
            serde_json::to_value(mandatory).unwrap(),
            serde_json::json!({
                "currentVersion": "0.5.0",
                "availableVersion": "0.6.0",
                "status": "mandatory",
                "policy": "mandatory",
                "progress": null,
                "errorCode": null
            })
        );
        assert_eq!(
            serde_json::to_value(current).unwrap(),
            serde_json::json!({
                "currentVersion": "0.6.0",
                "availableVersion": null,
                "status": "latest",
                "policy": null,
                "progress": null,
                "errorCode": null
            })
        );
        assert_eq!(
            serde_json::to_value(failed).unwrap(),
            serde_json::json!({
                "currentVersion": "0.5.0",
                "availableVersion": "0.6.0",
                "status": "failed",
                "policy": "mandatory",
                "progress": {"downloadedBytes": 25, "totalBytes": 100},
                "errorCode": "UPDATE_VERIFY_FAILED"
            })
        );
    }

    #[test]
    fn 같은_버전은_자동_설치_시도를_보존하고_새_버전은_초기화한다() {
        let previous = PendingUpdateMarker {
            schema_version: PENDING_UPDATE_SCHEMA_VERSION,
            version: "0.6.0".into(),
            auto_install_attempts: 2,
            retry_not_before_unix_seconds: 123,
        };

        assert_eq!(
            PendingUpdateMarker::for_version(Some(&previous), "0.6.0").auto_install_attempts,
            2
        );
        assert_eq!(
            PendingUpdateMarker::for_version(Some(&previous), "0.6.1").auto_install_attempts,
            0
        );
        assert_eq!(
            PendingUpdateMarker::for_version(Some(&previous), "0.6.0").retry_not_before_unix_seconds,
            123
        );
        assert_eq!(
            PendingUpdateMarker::for_version(Some(&previous), "0.6.1").retry_not_before_unix_seconds,
            0
        );
    }

    #[test]
    fn 자동_설치는_버전당_세번까지만_시도한다() {
        let mut marker = PendingUpdateMarker::for_version(None, "0.6.0");
        for _ in 0..MAX_AUTO_INSTALL_ATTEMPTS {
            assert!(marker.can_attempt_auto_install());
            marker.record_auto_install_attempt();
        }
        assert!(!marker.can_attempt_auto_install());
    }

    #[test]
    fn 실패한_자동_설치는_한시간_뒤에만_다시_시도한다() {
        let now = 1_000;
        let mut marker = PendingUpdateMarker::for_version(None, "0.6.0");

        marker.defer_auto_install(now);

        assert!(!marker.can_attempt_auto_install_at(now + AUTO_INSTALL_RETRY_BACKOFF_SECS - 1));
        assert!(marker.can_attempt_auto_install_at(now + AUTO_INSTALL_RETRY_BACKOFF_SECS));
        marker.record_auto_install_attempt();
        assert_eq!(marker.retry_not_before_unix_seconds, 0);
    }

    #[test]
    fn 시도_상한에_도달한_marker는_시작_preflight를_지연시키지_않는다() {
        let eligible = UpdateCoordinator {
            operation: Mutex::new(UpdateOperationState {
                cached: None,
                pending: Some(PendingUpdateMarker {
                    schema_version: PENDING_UPDATE_SCHEMA_VERSION,
                    version: "0.6.0".into(),
                    auto_install_attempts: MAX_AUTO_INSTALL_ATTEMPTS - 1,
                    retry_not_before_unix_seconds: 0,
                }),
            }),
            status_snapshot: RwLock::new(DesktopUpdateStatus::checking("0.5.0")),
            session_state: AtomicU8::new(SESSION_BACKGROUND),
            marker_path: PathBuf::new(),
        };
        let exhausted = UpdateCoordinator {
            operation: Mutex::new(UpdateOperationState {
                cached: None,
                pending: Some(PendingUpdateMarker {
                    schema_version: PENDING_UPDATE_SCHEMA_VERSION,
                    version: "0.6.0".into(),
                    auto_install_attempts: MAX_AUTO_INSTALL_ATTEMPTS,
                    retry_not_before_unix_seconds: 0,
                }),
            }),
            status_snapshot: RwLock::new(DesktopUpdateStatus::checking("0.5.0")),
            session_state: AtomicU8::new(SESSION_BACKGROUND),
            marker_path: PathBuf::new(),
        };
        let backed_off = UpdateCoordinator {
            operation: Mutex::new(UpdateOperationState {
                cached: None,
                pending: Some(PendingUpdateMarker {
                    schema_version: PENDING_UPDATE_SCHEMA_VERSION,
                    version: "0.6.0".into(),
                    auto_install_attempts: 0,
                    retry_not_before_unix_seconds: i64::MAX,
                }),
            }),
            status_snapshot: RwLock::new(DesktopUpdateStatus::checking("0.5.0")),
            session_state: AtomicU8::new(SESSION_BACKGROUND),
            marker_path: PathBuf::new(),
        };

        assert!(tauri::async_runtime::block_on(eligible.has_pending_auto_install()));
        assert!(!tauri::async_runtime::block_on(exhausted.has_pending_auto_install()));
        assert!(!tauri::async_runtime::block_on(backed_off.has_pending_auto_install()));
    }

    #[test]
    fn 업데이트_발견은_시도수를_보존하고_설치_직전_기록만_증가시킨다() {
        let directory = tempfile::tempdir().unwrap();
        let coordinator = UpdateCoordinator {
            operation: Mutex::new(UpdateOperationState::default()),
            status_snapshot: RwLock::new(DesktopUpdateStatus::checking("0.5.0")),
            session_state: AtomicU8::new(SESSION_BACKGROUND),
            marker_path: directory.path().join(PENDING_UPDATE_FILE),
        };
        let mut state = UpdateOperationState {
            cached: None,
            pending: Some(PendingUpdateMarker {
                schema_version: PENDING_UPDATE_SCHEMA_VERSION,
                version: "0.6.0".into(),
                auto_install_attempts: 1,
                retry_not_before_unix_seconds: 0,
            }),
        };

        coordinator.persist_pending_version(&mut state, "0.6.0").unwrap();
        assert_eq!(state.pending.as_ref().unwrap().auto_install_attempts, 1);
        coordinator.record_install_attempt(&mut state, "0.6.0").unwrap();
        assert_eq!(state.pending.as_ref().unwrap().auto_install_attempts, 2);
    }

    #[test]
    fn 최신_확인_오류에도_이전_mandatory_cache를_실패_상태로_보존한다() {
        let mut state = UpdateOperationState {
            cached: Some(CachedUpdateCheck {
                status: DesktopUpdateStatus::new("0.5.0", Some("0.6.0".into())),
                update: None,
            }),
            pending: None,
        };

        assert!(state.remember_failure("UPDATE_CHECK_FAILED"));
        let checked = state.cached_check().unwrap().unwrap();
        assert_eq!(checked.status.status, DesktopUpdateStage::Failed);
        assert_eq!(checked.status.policy, Some(DesktopUpdatePolicy::Mandatory));
        assert_eq!(checked.status.error_code.as_deref(), Some("UPDATE_CHECK_FAILED"));
    }

    #[test]
    fn 서명_오류와_네트워크_오류를_검증과_다운로드_단계로_구분한다() {
        assert_eq!(
            updater_operation_error_code(&tauri_plugin_updater::Error::SignatureUtf8("bad".into())),
            "UPDATE_VERIFY_FAILED"
        );
        assert_eq!(
            updater_operation_error_code(&tauri_plugin_updater::Error::Network("offline".into())),
            "UPDATE_DOWNLOAD_FAILED"
        );
    }

    #[test]
    fn 설치_확정과_사용자_창_열기는_하나만_먼저_상태를_선점한다() {
        let foreground_first = UpdateCoordinator {
            operation: Mutex::new(UpdateOperationState::default()),
            status_snapshot: RwLock::new(DesktopUpdateStatus::checking("0.5.0")),
            session_state: AtomicU8::new(SESSION_BACKGROUND),
            marker_path: PathBuf::new(),
        };
        assert!(foreground_first.mark_foreground_seen());
        assert!(!foreground_first.try_begin_auto_install());

        let install_first = UpdateCoordinator {
            operation: Mutex::new(UpdateOperationState::default()),
            status_snapshot: RwLock::new(DesktopUpdateStatus::checking("0.5.0")),
            session_state: AtomicU8::new(SESSION_BACKGROUND),
            marker_path: PathBuf::new(),
        };
        assert!(install_first.try_begin_auto_install());
        assert!(!install_first.mark_foreground_seen());
    }

    #[test]
    fn pending_marker는_atomic_write로_보존하고_현재_버전이_되면_삭제한다() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(PENDING_UPDATE_FILE);
        let marker = PendingUpdateMarker {
            schema_version: PENDING_UPDATE_SCHEMA_VERSION,
            version: "0.6.0".into(),
            auto_install_attempts: 1,
            retry_not_before_unix_seconds: 0,
        };
        persist_pending_marker(&path, &marker).unwrap();

        assert_eq!(
            load_pending_marker(&path, &Version::parse("0.5.9").unwrap()),
            Some(marker)
        );
        assert!(load_pending_marker(&path, &Version::parse("0.6.0").unwrap()).is_none());
        assert!(!path.exists());
    }

    #[test]
    fn 손상된_pending_marker는_앱을_막지_않고_폐기한다() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(PENDING_UPDATE_FILE);
        fs::write(&path, b"not-json").unwrap();

        assert!(load_pending_marker(&path, &Version::parse("0.5.9").unwrap()).is_none());
        assert!(!path.exists());
    }
}
