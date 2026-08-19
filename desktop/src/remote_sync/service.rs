use super::*;
use std::path::PathBuf;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
enum EnrollmentState {
    #[default]
    New,
    Enrolled,
    ResetRequired,
}

#[derive(Debug, Default)]
pub(crate) struct SyncRuntime {
    pub(crate) credential_persistent: bool,
    pub(crate) last_server_contact: Option<DateTime<Utc>>,
    pub(crate) last_error: Option<String>,
    enrollment_state: EnrollmentState,
}

struct AuthenticatedRequest {
    bearer: Zeroizing<String>,
    identity_generation: u64,
}

pub(crate) struct RemoteNotificationBatch {
    pub(crate) identity_generation: u64,
    pub(crate) notifications: Vec<RemoteNotification>,
}

pub(crate) struct RemoteSyncService {
    api: RemoteApi,
    app_data_dir: PathBuf,
    installation_id: RwLock<String>,
    credential_store: Arc<dyn CredentialStore>,
    credential: RwLock<Option<BearerCredential>>,
    registration: Mutex<()>,
    credential_transition: Mutex<()>,
    identity_transition: RwLock<()>,
    identity_generation: AtomicU64,
    webview_session_transition: Mutex<()>,
    pub(crate) runtime: Mutex<SyncRuntime>,
    pub(crate) snapshot_revision: AtomicU64,
    pub(crate) snapshot_uploaded: Notify,
}

impl RemoteSyncService {
    /// 분석 모듈이 원문을 외부에 노출하지 않고 해시하기 위한 로컬 설치 식별자다.
    /// WebView/IPC 응답에는 포함하지 않는다.
    pub(crate) async fn installation_id_for_analytics(&self) -> String {
        self.installation_id.read().await.clone()
    }

    pub(crate) async fn configured(app: &tauri::AppHandle) -> Result<Self, String> {
        let app_data_dir = app
            .path()
            .app_data_dir()
            .map_err(|_| "CONNECTED_SERVICE_STORAGE_UNAVAILABLE".to_owned())?;
        let api_base_url = crate::data_api::base_url();
        run_blocking_initialization(move || {
            let identity =
                secure_credential::load_or_create_installation_identity(&app_data_dir).map_err(str::to_owned)?;
            let credential_store =
                secure_credential::platform_credential_store(&app_data_dir).map_err(str::to_owned)?;
            let api = RemoteApi::new(&api_base_url).map_err(|error| error.code().to_owned())?;
            let service = Self::with_store(api, app_data_dir, identity.id, identity.newly_created, credential_store)
                .map_err(|error| error.code().to_owned())?;
            let storage = match secure_credential::platform_credential_store_kind() {
                PlatformCredentialStoreKind::PrivateFile => "private app storage",
                PlatformCredentialStoreKind::OperatingSystemVault => "the operating system credential vault",
            };
            log::info!("[connected-service] server credential uses {storage}");
            Ok(service)
        })
        .await
    }

    pub(crate) fn with_store(
        api: RemoteApi,
        app_data_dir: PathBuf,
        installation_id: String,
        identity_is_new: bool,
        credential_store: Arc<dyn CredentialStore>,
    ) -> Result<Self, ServiceError> {
        secure_credential::parse_installation_id(&installation_id).map_err(|_| ServiceError::Storage)?;
        let loaded = if credential_store.is_persistent() {
            credential_store.load_validated(&|value| {
                decode_stored_credential(value).is_ok_and(|credential| credential.is_valid_at(Utc::now()))
            })
        } else {
            Ok(None)
        };
        let mut credential_persistent = false;
        let mut restore_failed = false;
        let credential = match loaded {
            Ok(Some(stored)) => match decode_stored_credential(&stored) {
                Ok(credential) if credential.is_valid_at(Utc::now()) => {
                    credential_persistent = true;
                    Some(credential)
                }
                _ => {
                    restore_failed = true;
                    let _ = credential_store.clear();
                    None
                }
            },
            Ok(None) => None,
            Err(error) => {
                log::warn!("[connected-service] credential restore unavailable: {error}");
                restore_failed = true;
                None
            }
        };
        let enrollment_state = if credential.is_some() {
            EnrollmentState::Enrolled
        } else if identity_is_new && !restore_failed {
            EnrollmentState::New
        } else {
            EnrollmentState::ResetRequired
        };
        let runtime = SyncRuntime {
            credential_persistent,
            enrollment_state,
            ..SyncRuntime::default()
        };
        Ok(Self {
            api,
            app_data_dir,
            installation_id: RwLock::new(installation_id),
            credential_store,
            credential: RwLock::new(credential),
            registration: Mutex::new(()),
            credential_transition: Mutex::new(()),
            identity_transition: RwLock::new(()),
            identity_generation: AtomicU64::new(0),
            webview_session_transition: Mutex::new(()),
            runtime: Mutex::new(runtime),
            snapshot_revision: AtomicU64::new(0),
            snapshot_uploaded: Notify::new(),
        })
    }

    pub(crate) async fn status(&self) -> ConnectedServiceStatus {
        let _identity = self.identity_transition.read().await;
        let authenticated = self.current_bearer().await.is_some();
        let runtime = self.runtime.lock().await;
        ConnectedServiceStatus {
            authenticated,
            credential_persistent: runtime.credential_persistent,
            identity_reset_required: runtime.enrollment_state == EnrollmentState::ResetRequired,
            lms_session_state: LmsSessionState::Unknown,
            last_server_contact: runtime.last_server_contact,
            last_error: runtime.last_error.clone(),
        }
    }

    pub(crate) fn registration_needed(&self) -> bool {
        self.credential
            .try_read()
            .map(|credential| {
                credential.as_ref().is_none_or(|credential| {
                    !credential.is_valid_at(Utc::now()) || credential.should_rotate_at(Utc::now())
                })
            })
            .unwrap_or(false)
    }

    pub(crate) async fn current_bearer(&self) -> Option<Zeroizing<String>> {
        let credential = self.credential.read().await;
        credential
            .as_ref()
            .filter(|credential| credential.is_valid_at(Utc::now()))
            .map(|credential| Zeroizing::new(credential.token.to_string()))
    }

    #[cfg(test)]
    async fn require_bearer(&self) -> Result<Zeroizing<String>, ServiceError> {
        Ok(self.authenticated_request().await?.bearer)
    }

    async fn authenticated_request(&self) -> Result<AuthenticatedRequest, ServiceError> {
        self.authenticated_request_for_generation(None).await
    }

    async fn authenticated_request_for_generation(
        &self,
        expected_generation: Option<u64>,
    ) -> Result<AuthenticatedRequest, ServiceError> {
        loop {
            let generation = self.identity_generation.load(Ordering::Acquire);
            if expected_generation.is_some_and(|expected| expected != generation) {
                return Err(ServiceError::StaleIdentity);
            }
            let registration = self.ensure_registered().await;
            let _identity = self.identity_transition.read().await;
            if self.identity_generation.load(Ordering::Acquire) != generation {
                if expected_generation.is_some() {
                    return Err(ServiceError::StaleIdentity);
                }
                continue;
            }
            registration?;
            let bearer = self
                .current_bearer()
                .await
                .ok_or(ServiceError::AuthenticationRequired)?;
            return Ok(AuthenticatedRequest {
                bearer,
                identity_generation: generation,
            });
        }
    }

    async fn record_success(&self) {
        let mut runtime = self.runtime.lock().await;
        runtime.last_server_contact = Some(Utc::now());
        runtime.last_error = None;
    }

    async fn record_error(&self, error: ServiceError) {
        self.runtime.lock().await.last_error = Some(error.code().into());
    }

    async fn record_request_error(&self, error: ServiceError, request: &AuthenticatedRequest) -> bool {
        let _identity = self.identity_transition.read().await;
        if self.identity_generation.load(Ordering::Acquire) != request.identity_generation {
            return false;
        }
        if error != ServiceError::AuthenticationRequired || self.invalidate_credential_if_current(&request.bearer).await
        {
            self.record_error(error).await;
        }
        true
    }

    async fn complete_authenticated_success(&self, request: &AuthenticatedRequest) -> bool {
        let _identity = self.identity_transition.read().await;
        if self.identity_generation.load(Ordering::Acquire) != request.identity_generation {
            return false;
        }
        self.record_success().await;
        true
    }

    async fn complete_attendance_success(&self, request: &AuthenticatedRequest) -> Option<u64> {
        let _identity = self.identity_transition.read().await;
        if self.identity_generation.load(Ordering::Acquire) != request.identity_generation {
            return None;
        }
        self.record_success().await;
        let revision = self.snapshot_revision.fetch_add(1, Ordering::AcqRel) + 1;
        self.snapshot_uploaded.notify_waiters();
        Some(revision)
    }

    pub(crate) async fn with_current_identity<T>(
        &self,
        identity_generation: u64,
        apply: impl FnOnce() -> T,
    ) -> Option<T> {
        let _identity = self.identity_transition.read().await;
        (self.identity_generation.load(Ordering::Acquire) == identity_generation).then(apply)
    }

    async fn install_credential_for_generation(&self, credential: BearerCredential, expected_generation: u64) -> bool {
        let _identity = self.identity_transition.read().await;
        if self.identity_generation.load(Ordering::Acquire) != expected_generation {
            return false;
        }
        self.install_credential(credential).await;
        true
    }

    async fn invalidate_credential_if_current(&self, request_bearer: &str) -> bool {
        let _transition = self.credential_transition.lock().await;
        {
            let mut credential = self.credential.write().await;
            if credential
                .as_ref()
                .is_none_or(|current| current.token.as_str() != request_bearer)
            {
                return false;
            }
            *credential = None;
        }
        let cleared = clear_credential_store(Arc::clone(&self.credential_store)).await.is_ok();
        let mut runtime = self.runtime.lock().await;
        runtime.credential_persistent = false;
        runtime.enrollment_state = EnrollmentState::ResetRequired;
        if self.credential_store.is_persistent() && !cleared {
            runtime.last_error = Some(ServiceError::Storage.code().into());
        }
        true
    }

    pub(crate) async fn ensure_registered(&self) -> Result<(), ServiceError> {
        {
            let credential = self.credential.read().await;
            if credential.as_ref().is_some_and(|credential| {
                credential.is_valid_at(Utc::now()) && !credential.should_rotate_at(Utc::now())
            }) {
                return Ok(());
            }
        }
        let _registration = self.registration.lock().await;
        let identity_generation = self.identity_generation.load(Ordering::Acquire);

        let active = {
            let credential = self.credential.read().await;
            credential
                .as_ref()
                .filter(|credential| credential.is_valid_at(Utc::now()))
                .map(|credential| {
                    (
                        Zeroizing::new(credential.token.to_string()),
                        credential.should_rotate_at(Utc::now()),
                    )
                })
        };
        if let Some((bearer, should_rotate)) = active {
            if !should_rotate {
                return Ok(());
            }
            match self.api.rotate_installation(&bearer).await {
                Ok(credential) => {
                    if !self
                        .install_credential_for_generation(credential, identity_generation)
                        .await
                    {
                        return Err(ServiceError::StaleIdentity);
                    }
                    log::info!("[connected-service] desktop credential rotated");
                    return Ok(());
                }
                Err(error) => {
                    let request = AuthenticatedRequest {
                        bearer,
                        identity_generation: self.identity_generation.load(Ordering::Acquire),
                    };
                    self.record_request_error(error, &request).await;
                    if self.current_bearer().await.is_some() {
                        return Ok(());
                    }
                    return Err(error);
                }
            }
        }

        if self.runtime.lock().await.enrollment_state != EnrollmentState::New {
            return Err(ServiceError::IdentityResetRequired);
        }
        let installation_id = self.installation_id.read().await.clone();
        let result = self.api.register_installation(&installation_id).await;
        match result {
            Ok(credential) => {
                if !self
                    .install_credential_for_generation(credential, identity_generation)
                    .await
                {
                    return Err(ServiceError::StaleIdentity);
                }
                log::info!("[connected-service] desktop installation registered");
                Ok(())
            }
            Err(error) => {
                self.record_error(error).await;
                if matches!(error, ServiceError::AuthenticationRequired | ServiceError::Rejected) {
                    self.runtime.lock().await.enrollment_state = EnrollmentState::ResetRequired;
                }
                Err(error)
            }
        }
    }

    async fn install_credential(&self, credential: BearerCredential) {
        let _transition = self.credential_transition.lock().await;
        let persistence_enabled = self.credential_store.is_persistent();
        let persisted = persistence_enabled
            && persist_credential_async(Arc::clone(&self.credential_store), &credential)
                .await
                .is_ok();
        *self.credential.write().await = Some(credential);
        let mut runtime = self.runtime.lock().await;
        runtime.credential_persistent = persisted;
        runtime.enrollment_state = EnrollmentState::Enrolled;
        runtime.last_server_contact = Some(Utc::now());
        runtime.last_error = if persistence_enabled && !persisted {
            Some(ServiceError::Storage.code().into())
        } else {
            None
        };
    }

    pub(crate) async fn bootstrap_http_session(&self, origin: &str) -> Result<DesktopHttpSession, String> {
        // Identity reset revokes by parent+origin. Hold one transition lock across
        // bearer lookup and issue so reset cannot revoke and then race with a late issue.
        let _transition = self.webview_session_transition.lock().await;
        let request = self
            .authenticated_request()
            .await
            .map_err(|error| error.code().to_owned())?;
        match self.api.bootstrap_webview_session(&request.bearer, origin).await {
            Ok(session) => {
                if self.complete_authenticated_success(&request).await {
                    Ok(session)
                } else {
                    Err(ServiceError::StaleIdentity.code().into())
                }
            }
            Err(error) => {
                if self.record_request_error(error, &request).await {
                    Err(error.code().into())
                } else {
                    Err(ServiceError::StaleIdentity.code().into())
                }
            }
        }
    }

    pub(crate) async fn reset_identity(&self, _origin: &str) -> Result<ConnectedServiceStatus, String> {
        let _transition = self.webview_session_transition.lock().await;
        let registration = self.registration.lock().await;
        let identity_transition = self.identity_transition.write().await;
        if let Some(bearer) = self.current_bearer().await {
            if let Err(error) = self.api.delete_installation(&bearer).await {
                self.record_error(error).await;
                return Err(error.code().to_owned());
            }
        }
        self.identity_generation.fetch_add(1, Ordering::AcqRel);
        let credential_transition = self.credential_transition.lock().await;
        clear_credential_store(Arc::clone(&self.credential_store))
            .await
            .map_err(|error| error.code().to_owned())?;
        let identity = secure_credential::reset_installation_identity(&self.app_data_dir).map_err(str::to_owned)?;
        *self.installation_id.write().await = identity.id;
        *self.credential.write().await = None;
        {
            let mut runtime = self.runtime.lock().await;
            runtime.credential_persistent = false;
            runtime.enrollment_state = EnrollmentState::New;
            runtime.last_server_contact = None;
            runtime.last_error = None;
        }
        drop(credential_transition);
        drop(identity_transition);
        drop(registration);
        if let Err(error) = self.ensure_registered().await {
            log::warn!(
                "[connected-service] registration after identity reset deferred: {}",
                error.code()
            );
        }
        Ok(self.status().await)
    }

    pub(crate) async fn upload_attendance(&self, snapshot: &AttendanceSnapshot) -> Result<u64, String> {
        let request = self
            .authenticated_request()
            .await
            .map_err(|error| error.code().to_owned())?;
        match self.api.put_attendance(&request.bearer, snapshot).await {
            Ok(_) => {
                if let Some(revision) = self.complete_attendance_success(&request).await {
                    Ok(revision)
                } else {
                    Err(ServiceError::StaleIdentity.code().into())
                }
            }
            Err(error) => {
                if self.record_request_error(error, &request).await {
                    Err(error.code().into())
                } else {
                    Err(ServiceError::StaleIdentity.code().into())
                }
            }
        }
    }

    pub(crate) async fn broadcast_test_notification(&self, desktop_delivered: bool) -> Result<usize, String> {
        let request = self
            .authenticated_request()
            .await
            .map_err(|error| error.code().to_owned())?;
        match self
            .api
            .send_test_notification(&request.bearer, desktop_delivered)
            .await
        {
            Ok(broadcast) => {
                if self.complete_authenticated_success(&request).await {
                    Ok(broadcast.queued)
                } else {
                    Err(ServiceError::StaleIdentity.code().into())
                }
            }
            Err(error) => {
                if self.record_request_error(error, &request).await {
                    Err(error.code().into())
                } else {
                    Err(ServiceError::StaleIdentity.code().into())
                }
            }
        }
    }

    pub(crate) async fn wait_for_snapshot_after(&self, baseline: u64) {
        loop {
            let notified = self.snapshot_uploaded.notified();
            if self.snapshot_revision.load(Ordering::Acquire) > baseline {
                return;
            }
            notified.await;
        }
    }

    pub(crate) async fn send_heartbeat(&self, state: LmsSessionState) -> Result<(), ServiceError> {
        let request = self.authenticated_request().await?;
        let result = self.api.heartbeat(&request.bearer, state).await;
        match result {
            Ok(()) => {
                if self.complete_authenticated_success(&request).await {
                    Ok(())
                } else {
                    Err(ServiceError::StaleIdentity)
                }
            }
            Err(error) => {
                if self.record_request_error(error, &request).await {
                    Err(error)
                } else {
                    Err(ServiceError::StaleIdentity)
                }
            }
        }
    }

    pub(crate) async fn poll_notifications(&self) -> Result<RemoteNotificationBatch, ServiceError> {
        let request = self.authenticated_request().await?;
        let result = self.api.notifications(&request.bearer).await;
        match result {
            Ok(notifications) => {
                if self.complete_authenticated_success(&request).await {
                    Ok(RemoteNotificationBatch {
                        identity_generation: request.identity_generation,
                        notifications,
                    })
                } else {
                    Err(ServiceError::StaleIdentity)
                }
            }
            Err(error) => {
                if self.record_request_error(error, &request).await {
                    Err(error)
                } else {
                    Err(ServiceError::StaleIdentity)
                }
            }
        }
    }

    pub(crate) async fn acknowledge(
        &self,
        notification_id: &str,
        outcome: NotificationAckOutcome,
        identity_generation: u64,
    ) -> Result<(), ServiceError> {
        let request = self
            .authenticated_request_for_generation(Some(identity_generation))
            .await?;
        let result = self
            .api
            .acknowledge_notification(&request.bearer, notification_id, outcome)
            .await;
        match result {
            Ok(()) => {
                if self.complete_authenticated_success(&request).await {
                    Ok(())
                } else {
                    Err(ServiceError::StaleIdentity)
                }
            }
            Err(error) => {
                if self.record_request_error(error, &request).await {
                    Err(error)
                } else {
                    Err(ServiceError::StaleIdentity)
                }
            }
        }
    }
}

async fn run_blocking_initialization<T, F>(initializer: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(initializer)
        .await
        .map_err(|_| "CONNECTED_SERVICE_STORAGE_UNAVAILABLE".to_owned())?
}

pub(crate) fn decode_stored_credential(value: &str) -> Result<BearerCredential, ServiceError> {
    let stored: StoredCredentialValue = serde_json::from_str(value).map_err(|_| ServiceError::Storage)?;
    if stored.schema != DESKTOP_SESSION_SCHEMA || stored.schema_version != DESKTOP_SESSION_SCHEMA_VERSION {
        return Err(ServiceError::Storage);
    }
    BearerCredential::from_wire(stored.access_token, &stored.expires_at).map_err(|_| ServiceError::Storage)
}

fn encode_stored_credential(credential: &BearerCredential) -> Result<Zeroizing<String>, ServiceError> {
    let value = StoredCredentialRef {
        schema: DESKTOP_SESSION_SCHEMA,
        schema_version: DESKTOP_SESSION_SCHEMA_VERSION,
        access_token: &credential.token,
        expires_at: credential.expires_at.to_rfc3339_opts(SecondsFormat::Millis, true),
    };
    serde_json::to_string(&value)
        .map(Zeroizing::new)
        .map_err(|_| ServiceError::Storage)
}

#[cfg(test)]
pub(crate) fn persist_credential(
    store: &dyn CredentialStore,
    credential: &BearerCredential,
) -> Result<(), ServiceError> {
    let serialized = encode_stored_credential(credential)?;
    store.store(&serialized).map_err(|_| ServiceError::Storage)
}

async fn persist_credential_async(
    store: Arc<dyn CredentialStore>,
    credential: &BearerCredential,
) -> Result<(), ServiceError> {
    let serialized = encode_stored_credential(credential)?;
    tauri::async_runtime::spawn_blocking(move || store.store(&serialized))
        .await
        .map_err(|_| ServiceError::Storage)?
        .map_err(|_| ServiceError::Storage)
}

async fn clear_credential_store(store: Arc<dyn CredentialStore>) -> Result<(), ServiceError> {
    tauri::async_runtime::spawn_blocking(move || store.clear())
        .await
        .map_err(|_| ServiceError::Storage)?
        .map_err(|_| ServiceError::Storage)
}

#[cfg(test)]
mod initialization_tests {
    use super::*;
    use std::sync::{Arc as StdArc, Mutex as StdMutex};
    use tokio::sync::oneshot;

    #[tokio::test(flavor = "current_thread")]
    async fn configured_initialization_runs_on_the_blocking_pool_and_is_awaited() {
        let caller = std::thread::current().id();
        let initializer_thread = StdArc::new(StdMutex::new(None));
        let observed = StdArc::clone(&initializer_thread);

        run_blocking_initialization(move || {
            *observed.lock().unwrap() = Some(std::thread::current().id());
            Ok::<_, String>(())
        })
        .await
        .unwrap();

        let initialized_on = initializer_thread.lock().unwrap().unwrap();
        assert_ne!(initialized_on, caller);
    }

    #[tokio::test]
    async fn stale_authenticated_401_after_rotation_does_not_invalidate_new_credential() {
        let directory = tempfile::tempdir().unwrap();
        let store = StdArc::new(crate::secure_credential::MemoryCredentialStore::new(None));
        let service = StdArc::new(
            RemoteSyncService::with_store(
                RemoteApi::new("https://bell.example.com").unwrap(),
                directory.path().to_path_buf(),
                uuid::Uuid::new_v4().hyphenated().to_string(),
                true,
                store.clone(),
            )
            .unwrap(),
        );
        let old_bearer = format!("jbd_{}", "a".repeat(64));
        let new_bearer = format!("jbd_{}", "b".repeat(64));
        service
            .install_credential(BearerCredential {
                token: Zeroizing::new(old_bearer.clone()),
                expires_at: Utc::now() + chrono::Duration::days(30),
            })
            .await;

        let (rotation_installed, observe_old_response) = oneshot::channel();
        let rotating_service = StdArc::clone(&service);
        let rotated_bearer = new_bearer.clone();
        let rotation = async move {
            rotating_service
                .install_credential(BearerCredential {
                    token: Zeroizing::new(rotated_bearer),
                    expires_at: Utc::now() + chrono::Duration::days(30),
                })
                .await;
            rotation_installed.send(()).unwrap();
        };
        let stale_response_service = StdArc::clone(&service);
        let stale_response = async move {
            observe_old_response.await.unwrap();
            let request = AuthenticatedRequest {
                bearer: Zeroizing::new(old_bearer),
                identity_generation: stale_response_service.identity_generation.load(Ordering::Acquire),
            };
            stale_response_service
                .record_request_error(ServiceError::AuthenticationRequired, &request)
                .await;
        };
        tokio::join!(rotation, stale_response);

        assert_eq!(
            service.current_bearer().await.as_deref().map(String::as_str),
            Some(new_bearer.as_str())
        );
        let persisted = store.load().unwrap().unwrap();
        assert_eq!(decode_stored_credential(&persisted).unwrap().token.as_str(), new_bearer);
        let status = service.status().await;
        assert!(status.authenticated);
        assert!(!status.identity_reset_required);
        assert!(status.last_error.is_none());
    }

    #[tokio::test]
    async fn current_authenticated_401_still_invalidates_its_credential() {
        let directory = tempfile::tempdir().unwrap();
        let store = StdArc::new(crate::secure_credential::MemoryCredentialStore::new(None));
        let service = RemoteSyncService::with_store(
            RemoteApi::new("https://bell.example.com").unwrap(),
            directory.path().to_path_buf(),
            uuid::Uuid::new_v4().hyphenated().to_string(),
            true,
            store.clone(),
        )
        .unwrap();
        let bearer = format!("jbd_{}", "a".repeat(64));
        service
            .install_credential(BearerCredential {
                token: Zeroizing::new(bearer.clone()),
                expires_at: Utc::now() + chrono::Duration::days(30),
            })
            .await;

        service
            .record_request_error(
                ServiceError::AuthenticationRequired,
                &AuthenticatedRequest {
                    bearer: Zeroizing::new(bearer),
                    identity_generation: service.identity_generation.load(Ordering::Acquire),
                },
            )
            .await;

        assert!(service.current_bearer().await.is_none());
        assert!(store.load().unwrap().is_none());
        let status = service.status().await;
        assert!(status.identity_reset_required);
        assert_eq!(
            status.last_error.as_deref(),
            Some(ServiceError::AuthenticationRequired.code())
        );
    }

    #[tokio::test]
    async fn require_bearer_rotates_a_valid_credential_inside_the_rotation_window() {
        let old_bearer = format!("jbd_{}", "a".repeat(64));
        let new_bearer = format!("jbd_{}", "b".repeat(64));
        let directory = tempfile::tempdir().unwrap();
        let store = StdArc::new(crate::secure_credential::MemoryCredentialStore::new(None));
        let service = RemoteSyncService::with_store(
            RemoteApi::with_rotation_result(Ok(BearerCredential {
                token: Zeroizing::new(new_bearer.clone()),
                expires_at: Utc::now() + chrono::Duration::days(30),
            })),
            directory.path().to_path_buf(),
            uuid::Uuid::new_v4().hyphenated().to_string(),
            true,
            store.clone(),
        )
        .unwrap();
        service
            .install_credential(BearerCredential {
                token: Zeroizing::new(old_bearer.clone()),
                expires_at: Utc::now() + chrono::Duration::days(6),
            })
            .await;

        let bearer = service.require_bearer().await.unwrap();

        assert_eq!(bearer.as_str(), new_bearer);
        assert_eq!(
            decode_stored_credential(&store.load().unwrap().unwrap())
                .unwrap()
                .token
                .as_str(),
            new_bearer
        );
    }

    #[tokio::test]
    async fn reset_discards_in_flight_attendance_completion_and_notification_delivery() {
        let directory = tempfile::tempdir().unwrap();
        let identity = secure_credential::load_or_create_installation_identity(directory.path()).unwrap();
        let store = StdArc::new(crate::secure_credential::MemoryCredentialStore::new(None));
        let service = StdArc::new(
            RemoteSyncService::with_store(
                RemoteApi::with_identity_deletion_result(Ok(())),
                directory.path().to_path_buf(),
                identity.id,
                false,
                store,
            )
            .unwrap(),
        );
        service
            .install_credential(BearerCredential {
                token: Zeroizing::new(format!("jbd_{}", "a".repeat(64))),
                expires_at: Utc::now() + chrono::Duration::days(30),
            })
            .await;
        let request = service.authenticated_request().await.unwrap();
        let request_generation = request.identity_generation;
        let baseline = service.snapshot_revision.load(Ordering::Acquire);
        let (reset_finished, release_old_response) = oneshot::channel();

        let resetting_service = StdArc::clone(&service);
        let reset = async move {
            resetting_service.reset_identity("tauri://localhost").await.unwrap();
            reset_finished.send(()).unwrap();
        };
        let completing_service = StdArc::clone(&service);
        let completion = async move {
            release_old_response.await.unwrap();
            completing_service.complete_attendance_success(&request).await
        };
        let (_, applied) = tokio::join!(reset, completion);

        assert_eq!(applied, None);
        assert_eq!(service.snapshot_revision.load(Ordering::Acquire), baseline);
        assert!(
            tokio::time::timeout(Duration::from_millis(10), service.wait_for_snapshot_after(baseline))
                .await
                .is_err()
        );
        let delivered = StdArc::new(std::sync::atomic::AtomicBool::new(false));
        let delivery_flag = StdArc::clone(&delivered);
        let delivery = service
            .with_current_identity(request_generation, move || {
                delivery_flag.store(true, std::sync::atomic::Ordering::Release);
            })
            .await;
        assert!(delivery.is_none());
        assert!(!delivered.load(std::sync::atomic::Ordering::Acquire));
        let status = service.status().await;
        assert!(status.last_server_contact.is_none());
        assert_eq!(status.last_error.as_deref(), Some(ServiceError::Unavailable.code()));
    }

    #[tokio::test]
    async fn bearer_rotation_keeps_in_flight_success_in_the_same_identity_generation() {
        let directory = tempfile::tempdir().unwrap();
        let store = StdArc::new(crate::secure_credential::MemoryCredentialStore::new(None));
        let service = RemoteSyncService::with_store(
            RemoteApi::new("https://bell.example.com").unwrap(),
            directory.path().to_path_buf(),
            uuid::Uuid::new_v4().hyphenated().to_string(),
            true,
            store,
        )
        .unwrap();
        service
            .install_credential(BearerCredential {
                token: Zeroizing::new(format!("jbd_{}", "a".repeat(64))),
                expires_at: Utc::now() + chrono::Duration::days(30),
            })
            .await;
        let request = service.authenticated_request().await.unwrap();
        service
            .install_credential(BearerCredential {
                token: Zeroizing::new(format!("jbd_{}", "b".repeat(64))),
                expires_at: Utc::now() + chrono::Duration::days(30),
            })
            .await;
        service.runtime.lock().await.last_server_contact = None;

        assert_eq!(service.complete_attendance_success(&request).await, Some(1));
        assert_eq!(service.snapshot_revision.load(Ordering::Acquire), 1);
        assert!(service.status().await.last_server_contact.is_some());
    }
}
