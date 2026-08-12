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

pub(crate) struct RemoteSyncService {
    api: RemoteApi,
    app_data_dir: PathBuf,
    installation_id: RwLock<String>,
    credential_store: Arc<dyn CredentialStore>,
    credential: RwLock<Option<BearerCredential>>,
    registration: Mutex<()>,
    pub(crate) runtime: Mutex<SyncRuntime>,
    pub(crate) snapshot_revision: AtomicU64,
    pub(crate) snapshot_uploaded: Notify,
}

impl RemoteSyncService {
    pub(crate) async fn configured(app: &tauri::AppHandle) -> Result<Self, String> {
        let app_data_dir = app
            .path()
            .app_data_dir()
            .map_err(|_| "CONNECTED_SERVICE_STORAGE_UNAVAILABLE".to_owned())?;
        let api_base_url = crate::data_api::base_url();
        run_blocking_initialization(move || {
            let identity =
                secure_credential::load_or_create_installation_identity(&app_data_dir).map_err(str::to_owned)?;
            let credential_store: Arc<dyn CredentialStore> =
                Arc::new(KeyringCredentialStore::new(&app_data_dir).map_err(str::to_owned)?);
            let api = RemoteApi::new(&api_base_url).map_err(|error| error.code().to_owned())?;
            let service = Self::with_store(api, app_data_dir, identity.id, identity.newly_created, credential_store)
                .map_err(|error| error.code().to_owned())?;
            log::info!("[connected-service] server credential uses the operating system credential vault");
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
            runtime: Mutex::new(runtime),
            snapshot_revision: AtomicU64::new(0),
            snapshot_uploaded: Notify::new(),
        })
    }

    pub(crate) async fn status(&self) -> ConnectedServiceStatus {
        let authenticated = self.current_bearer().await.is_some();
        let installation_id = self.installation_id.read().await.clone();
        let runtime = self.runtime.lock().await;
        ConnectedServiceStatus {
            authenticated,
            installation_id,
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

    async fn require_bearer(&self) -> Result<Zeroizing<String>, ServiceError> {
        if self.current_bearer().await.is_none() {
            self.ensure_registered().await?;
        }
        self.current_bearer().await.ok_or(ServiceError::AuthenticationRequired)
    }

    async fn record_success(&self) {
        let mut runtime = self.runtime.lock().await;
        runtime.last_server_contact = Some(Utc::now());
        runtime.last_error = None;
    }

    async fn record_error(&self, error: ServiceError) {
        if error == ServiceError::AuthenticationRequired {
            self.invalidate_credential().await;
        }
        self.runtime.lock().await.last_error = Some(error.code().into());
    }

    async fn invalidate_credential(&self) {
        *self.credential.write().await = None;
        let cleared = clear_credential_store(Arc::clone(&self.credential_store)).await.is_ok();
        let mut runtime = self.runtime.lock().await;
        runtime.credential_persistent = false;
        runtime.enrollment_state = EnrollmentState::ResetRequired;
        if self.credential_store.is_persistent() && !cleared {
            runtime.last_error = Some(ServiceError::Storage.code().into());
        }
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
                    self.install_credential(credential).await;
                    log::info!("[connected-service] desktop credential rotated");
                    return Ok(());
                }
                Err(error) => {
                    self.record_error(error).await;
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
                self.install_credential(credential).await;
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

    pub(crate) async fn reset_identity(&self) -> Result<ConnectedServiceStatus, String> {
        let registration = self.registration.lock().await;
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
        drop(registration);
        self.ensure_registered()
            .await
            .map_err(|error| error.code().to_owned())?;
        Ok(self.status().await)
    }

    pub(crate) async fn create_pairing(&self) -> Result<MobilePairing, String> {
        let bearer = self.require_bearer().await.map_err(|error| error.code().to_owned())?;
        match self.api.create_pairing(&bearer).await {
            Ok(pairing) => {
                self.record_success().await;
                Ok(pairing)
            }
            Err(error) => {
                self.record_error(error).await;
                Err(error.code().into())
            }
        }
    }

    pub(crate) async fn pairing_status(&self, pairing_id: &str) -> Result<MobilePairingStatus, String> {
        if !is_safe_route_segment(pairing_id) {
            return Err("PAIRING_ID_INVALID".into());
        }
        let bearer = self.require_bearer().await.map_err(|error| error.code().to_owned())?;
        match self.api.get_pairing_status(&bearer, pairing_id).await {
            Ok(status) => {
                self.record_success().await;
                Ok(status)
            }
            Err(error) => {
                self.record_error(error).await;
                Err(error.code().into())
            }
        }
    }

    pub(crate) async fn approve_pairing(&self, pairing_id: &str, claim_id: &str) -> Result<(), String> {
        if !is_safe_route_segment(pairing_id) || !is_safe_route_segment(claim_id) {
            return Err("PAIRING_CLAIM_INVALID".into());
        }
        let bearer = self.require_bearer().await.map_err(|error| error.code().to_owned())?;
        let status = self
            .api
            .get_pairing_status(&bearer, pairing_id)
            .await
            .map_err(|error| error.code().to_owned())?;
        let claim_matches =
            status.status == "claimed" && status.claim.as_ref().is_some_and(|claim| claim.claim_id == claim_id);
        if !claim_matches {
            return Err("PAIRING_CLAIM_MISMATCH".into());
        }
        match self.api.approve_pairing(&bearer, pairing_id).await {
            Ok(()) => {
                self.record_success().await;
                Ok(())
            }
            Err(error) => {
                self.record_error(error).await;
                Err(error.code().into())
            }
        }
    }

    pub(crate) async fn devices(&self) -> Result<Vec<MobileDevice>, String> {
        let bearer = self.require_bearer().await.map_err(|error| error.code().to_owned())?;
        match self.api.list_devices(&bearer).await {
            Ok(devices) => {
                self.record_success().await;
                Ok(devices)
            }
            Err(error) => {
                self.record_error(error).await;
                Err(error.code().into())
            }
        }
    }

    pub(crate) async fn revoke_device(&self, device_id: &str) -> Result<(), String> {
        if !is_safe_route_segment(device_id) {
            return Err("DEVICE_ID_INVALID".into());
        }
        let bearer = self.require_bearer().await.map_err(|error| error.code().to_owned())?;
        match self.api.revoke_device(&bearer, device_id).await {
            Ok(()) => {
                self.record_success().await;
                Ok(())
            }
            Err(error) => {
                self.record_error(error).await;
                Err(error.code().into())
            }
        }
    }

    pub(crate) async fn upload_attendance(&self, snapshot: &AttendanceSnapshot) -> Result<(), String> {
        let bearer = self.require_bearer().await.map_err(|error| error.code().to_owned())?;
        match self.api.put_attendance(&bearer, snapshot).await {
            Ok(_) => {
                self.record_success().await;
                self.snapshot_revision.fetch_add(1, Ordering::Release);
                self.snapshot_uploaded.notify_waiters();
                Ok(())
            }
            Err(error) => {
                self.record_error(error).await;
                Err(error.code().into())
            }
        }
    }

    pub(crate) async fn attendance(&self) -> Result<RemoteAttendanceEnvelope, String> {
        let bearer = self.require_bearer().await.map_err(|error| error.code().to_owned())?;
        match self.api.get_attendance(&bearer).await {
            Ok(attendance) => {
                self.record_success().await;
                Ok(attendance)
            }
            Err(error) => {
                self.record_error(error).await;
                Err(error.code().into())
            }
        }
    }

    pub(crate) async fn attendance_preferences(&self) -> Result<AttendancePreferences, String> {
        let bearer = self.require_bearer().await.map_err(|error| error.code().to_owned())?;
        match self.api.get_attendance_preferences(&bearer).await {
            Ok(preferences) => {
                self.record_success().await;
                Ok(preferences)
            }
            Err(error) => {
                self.record_error(error).await;
                Err(error.code().into())
            }
        }
    }

    pub(crate) async fn update_attendance_preferences(
        &self,
        input: &AttendancePreferences,
    ) -> Result<AttendancePreferences, String> {
        validate_attendance_preferences(input).map_err(|error| error.code().to_owned())?;
        let bearer = self.require_bearer().await.map_err(|error| error.code().to_owned())?;
        match self.api.put_attendance_preferences(&bearer, input).await {
            Ok(preferences) => {
                self.record_success().await;
                Ok(preferences)
            }
            Err(error) => {
                self.record_error(error).await;
                Err(error.code().into())
            }
        }
    }

    pub(crate) async fn meal_preferences(&self) -> Result<MealPreferences, String> {
        let bearer = self.require_bearer().await.map_err(|error| error.code().to_owned())?;
        match self.api.get_meal_preferences(&bearer).await {
            Ok(preferences) => {
                self.record_success().await;
                Ok(preferences)
            }
            Err(error) => {
                self.record_error(error).await;
                Err(error.code().into())
            }
        }
    }

    pub(crate) async fn update_meal_preferences(
        &self,
        input: &MealPreferencesInput,
    ) -> Result<MealPreferences, String> {
        let bearer = self.require_bearer().await.map_err(|error| error.code().to_owned())?;
        match self.api.put_meal_preferences(&bearer, input).await {
            Ok(preferences) => {
                self.record_success().await;
                Ok(preferences)
            }
            Err(error) => {
                self.record_error(error).await;
                Err(error.code().into())
            }
        }
    }

    pub(crate) async fn laundry_watches(&self) -> Result<LaundryWatchEnvelope, String> {
        let bearer = self.require_bearer().await.map_err(|error| error.code().to_owned())?;
        match self.api.list_laundry_watches(&bearer).await {
            Ok(watches) => {
                self.record_success().await;
                Ok(watches)
            }
            Err(error) => {
                self.record_error(error).await;
                Err(error.code().into())
            }
        }
    }

    pub(crate) async fn create_laundry_watch(&self, input: &LaundryWatchInput) -> Result<RemoteLaundryWatch, String> {
        validate_laundry_watch_input(input).map_err(|error| error.code().to_owned())?;
        let bearer = self.require_bearer().await.map_err(|error| error.code().to_owned())?;
        match self.api.create_laundry_watch(&bearer, input).await {
            Ok(watch) => {
                self.record_success().await;
                Ok(watch)
            }
            Err(error) => {
                self.record_error(error).await;
                Err(error.code().into())
            }
        }
    }

    pub(crate) async fn delete_laundry_watch(&self, watch_id: &str) -> Result<(), String> {
        if !is_laundry_resource_id(watch_id, "jbw_") {
            return Err(ServiceError::Rejected.code().into());
        }
        let bearer = self.require_bearer().await.map_err(|error| error.code().to_owned())?;
        match self.api.delete_laundry_watch(&bearer, watch_id).await {
            Ok(()) => {
                self.record_success().await;
                Ok(())
            }
            Err(error) => {
                self.record_error(error).await;
                Err(error.code().into())
            }
        }
    }

    pub(crate) async fn laundry_queue(&self) -> Result<LaundryQueueEnvelope, String> {
        let bearer = self.require_bearer().await.map_err(|error| error.code().to_owned())?;
        match self.api.list_laundry_queue(&bearer).await {
            Ok(queue) => {
                self.record_success().await;
                Ok(queue)
            }
            Err(error) => {
                self.record_error(error).await;
                Err(error.code().into())
            }
        }
    }

    pub(crate) async fn join_laundry_queue(&self, input: &LaundryQueueInput) -> Result<LaundryQueueEntry, String> {
        validate_laundry_queue_input(input).map_err(|error| error.code().to_owned())?;
        let bearer = self.require_bearer().await.map_err(|error| error.code().to_owned())?;
        match self.api.join_laundry_queue(&bearer, input).await {
            Ok(entry) => {
                self.record_success().await;
                Ok(entry)
            }
            Err(error) => {
                self.record_error(error).await;
                Err(error.code().into())
            }
        }
    }

    pub(crate) async fn leave_laundry_queue(&self, entry_id: &str) -> Result<(), String> {
        if !is_laundry_resource_id(entry_id, "jbq_") {
            return Err(ServiceError::Rejected.code().into());
        }
        let bearer = self.require_bearer().await.map_err(|error| error.code().to_owned())?;
        match self.api.leave_laundry_queue(&bearer, entry_id).await {
            Ok(()) => {
                self.record_success().await;
                Ok(())
            }
            Err(error) => {
                self.record_error(error).await;
                Err(error.code().into())
            }
        }
    }

    pub(crate) async fn broadcast_test_notification(&self, desktop_delivered: bool) -> Result<usize, String> {
        let bearer = self.require_bearer().await.map_err(|error| error.code().to_owned())?;
        match self.api.send_test_notification(&bearer, desktop_delivered).await {
            Ok(broadcast) => {
                self.record_success().await;
                Ok(broadcast.queued)
            }
            Err(error) => {
                self.record_error(error).await;
                Err(error.code().into())
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
        let bearer = self.require_bearer().await?;
        let result = self.api.heartbeat(&bearer, state).await;
        match result {
            Ok(()) => {
                self.record_success().await;
                Ok(())
            }
            Err(error) => {
                self.record_error(error).await;
                Err(error)
            }
        }
    }

    pub(crate) async fn poll_notifications(&self) -> Result<Vec<RemoteNotification>, ServiceError> {
        let bearer = self.require_bearer().await?;
        let result = self.api.notifications(&bearer).await;
        match result {
            Ok(notifications) => {
                self.record_success().await;
                Ok(notifications)
            }
            Err(error) => {
                self.record_error(error).await;
                Err(error)
            }
        }
    }

    pub(crate) async fn acknowledge(
        &self,
        notification_id: &str,
        outcome: NotificationAckOutcome,
    ) -> Result<(), ServiceError> {
        let bearer = self.require_bearer().await?;
        let result = self
            .api
            .acknowledge_notification(&bearer, notification_id, outcome)
            .await;
        match result {
            Ok(()) => {
                self.record_success().await;
                Ok(())
            }
            Err(error) => {
                self.record_error(error).await;
                Err(error)
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
}
