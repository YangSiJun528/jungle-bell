use super::*;
use reqwest::header::CACHE_CONTROL;

pub(crate) const UI_OPENED_RETRY_DELAYS: [Duration; 2] = [Duration::from_millis(250), Duration::from_secs(1)];

#[cfg(test)]
type UsagePreferenceTestResult = Arc<std::sync::Mutex<Option<Result<Option<bool>, ServiceError>>>>;

#[cfg(test)]
type UiOpenedTestResults = Arc<std::sync::Mutex<std::collections::VecDeque<Result<StatusCode, ServiceError>>>>;

#[cfg(test)]
#[derive(Clone)]
struct UsagePreferencePutBarrier {
    started: Arc<Notify>,
    release: Arc<Notify>,
}

#[cfg(test)]
#[derive(Clone)]
struct UiOpenedTestBarrier {
    started: Arc<Notify>,
    release: Arc<Notify>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct UiOpenedFailure {
    pub(crate) error: ServiceError,
    pub(crate) retryable: bool,
}

#[derive(Clone)]
pub(crate) struct RemoteApi {
    origin: Url,
    client: Client,
    #[cfg(test)]
    rotation_result: Arc<std::sync::Mutex<Option<Result<BearerCredential, ServiceError>>>>,
    #[cfg(test)]
    identity_deletion_result: Arc<std::sync::Mutex<Option<Result<(), ServiceError>>>>,
    #[cfg(test)]
    ui_opened_results: UiOpenedTestResults,
    #[cfg(test)]
    ui_opened_attempt_count: Arc<std::sync::atomic::AtomicUsize>,
    #[cfg(test)]
    ui_opened_barrier: Option<UiOpenedTestBarrier>,
    #[cfg(test)]
    usage_preference_get_result: UsagePreferenceTestResult,
    #[cfg(test)]
    usage_preference_put_result: UsagePreferenceTestResult,
    #[cfg(test)]
    usage_preference_put_barrier: Option<UsagePreferencePutBarrier>,
}

impl RemoteApi {
    pub(crate) fn new(origin: &str) -> Result<Self, ServiceError> {
        let normalized =
            normalize_api_origin(origin, cfg!(debug_assertions)).map_err(|_| ServiceError::InvalidResponse)?;
        let origin = Url::parse(&normalized).map_err(|_| ServiceError::InvalidResponse)?;
        let client = Client::builder()
            .redirect(Policy::none())
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(15))
            .https_only(!cfg!(debug_assertions))
            .user_agent(concat!("JungleBell/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|_| ServiceError::Unavailable)?;
        Ok(Self {
            origin,
            client,
            #[cfg(test)]
            rotation_result: Arc::new(std::sync::Mutex::new(None)),
            #[cfg(test)]
            identity_deletion_result: Arc::new(std::sync::Mutex::new(None)),
            #[cfg(test)]
            ui_opened_results: Arc::new(std::sync::Mutex::new(std::collections::VecDeque::new())),
            #[cfg(test)]
            ui_opened_attempt_count: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            #[cfg(test)]
            ui_opened_barrier: None,
            #[cfg(test)]
            usage_preference_get_result: Arc::new(std::sync::Mutex::new(None)),
            #[cfg(test)]
            usage_preference_put_result: Arc::new(std::sync::Mutex::new(None)),
            #[cfg(test)]
            usage_preference_put_barrier: None,
        })
    }

    #[cfg(test)]
    pub(crate) fn with_rotation_result(result: Result<BearerCredential, ServiceError>) -> Self {
        let mut api = Self::new("https://bell.example.com").unwrap();
        api.rotation_result = Arc::new(std::sync::Mutex::new(Some(result)));
        api
    }

    #[cfg(test)]
    pub(crate) fn with_identity_deletion_result(result: Result<(), ServiceError>) -> Self {
        let mut api = Self::new("http://127.0.0.1:9").unwrap();
        api.identity_deletion_result = Arc::new(std::sync::Mutex::new(Some(result)));
        api
    }

    #[cfg(test)]
    pub(crate) fn with_ui_opened_result(result: Result<(), ServiceError>) -> Self {
        match result {
            Ok(()) => Self::with_ui_opened_results([Ok(StatusCode::NO_CONTENT)]),
            Err(ServiceError::Unavailable) => Self::with_ui_opened_results([
                Err(ServiceError::Unavailable),
                Err(ServiceError::Unavailable),
                Err(ServiceError::Unavailable),
            ]),
            Err(error) => Self::with_ui_opened_results([Err(error)]),
        }
    }

    #[cfg(test)]
    pub(crate) fn with_ui_opened_results(results: impl IntoIterator<Item = Result<StatusCode, ServiceError>>) -> Self {
        let mut api = Self::new("https://bell.example.com").unwrap();
        api.ui_opened_results = Arc::new(std::sync::Mutex::new(results.into_iter().collect()));
        api
    }

    #[cfg(test)]
    pub(crate) fn with_blocked_ui_opened_result(
        result: Result<(), ServiceError>,
        started: Arc<Notify>,
        release: Arc<Notify>,
    ) -> Self {
        Self::with_blocked_ui_opened_results([result.map(|()| StatusCode::NO_CONTENT)], started, release)
    }

    #[cfg(test)]
    pub(crate) fn with_blocked_ui_opened_results(
        results: impl IntoIterator<Item = Result<StatusCode, ServiceError>>,
        started: Arc<Notify>,
        release: Arc<Notify>,
    ) -> Self {
        let mut api = Self::with_ui_opened_results(results);
        api.ui_opened_barrier = Some(UiOpenedTestBarrier { started, release });
        api
    }

    #[cfg(test)]
    pub(crate) fn ui_opened_attempt_count(&self) -> usize {
        self.ui_opened_attempt_count.load(std::sync::atomic::Ordering::Acquire)
    }

    #[cfg(test)]
    pub(crate) fn with_usage_preference_results(
        get: Option<Result<Option<bool>, ServiceError>>,
        put: Option<Result<Option<bool>, ServiceError>>,
    ) -> Self {
        let mut api = Self::new("https://bell.example.com").unwrap();
        api.usage_preference_get_result = Arc::new(std::sync::Mutex::new(get));
        api.usage_preference_put_result = Arc::new(std::sync::Mutex::new(put));
        api
    }

    #[cfg(test)]
    pub(crate) fn with_blocked_usage_preference_put(
        result: Result<Option<bool>, ServiceError>,
        started: Arc<Notify>,
        release: Arc<Notify>,
    ) -> Self {
        let mut api = Self::with_usage_preference_results(None, Some(result));
        api.usage_preference_put_barrier = Some(UsagePreferencePutBarrier { started, release });
        api
    }

    pub(crate) fn endpoint(&self, path: &str) -> Result<Url, ServiceError> {
        if !is_canonical_server_path(path) {
            return Err(ServiceError::Rejected);
        }
        self.origin.join(path).map_err(|_| ServiceError::InvalidResponse)
    }

    pub(crate) async fn register_installation(
        &self,
        installation_id: &str,
        usage_analytics_enabled: Option<bool>,
    ) -> Result<BearerCredential, ServiceError> {
        let response = self
            .client
            .post(self.endpoint(INSTALLATIONS_PATH)?)
            .json(&DesktopInstallationRequest {
                installation_id: installation_id.to_owned(),
                usage_analytics_enabled,
            })
            .send()
            .await
            .map_err(|_| ServiceError::Unavailable)?;
        ensure_status(&response, &[StatusCode::OK, StatusCode::CREATED])?;
        let body: DesktopInstallationResponse = decode_json_limited(response).await?;
        BearerCredential::from_wire(body.access_token, &body.expires_at)
    }

    pub(crate) async fn rotate_installation(&self, bearer: &str) -> Result<BearerCredential, ServiceError> {
        #[cfg(test)]
        if let Some(result) = self.rotation_result.lock().unwrap().take() {
            return result;
        }
        let response = self
            .client
            .post(self.endpoint(ROTATE_INSTALLATION_PATH)?)
            .bearer_auth(bearer)
            .json(&serde_json::json!({}))
            .send()
            .await
            .map_err(|_| ServiceError::Unavailable)?;
        ensure_authenticated_status(&response, &[StatusCode::OK])?;
        let body: DesktopInstallationResponse = decode_json_limited(response).await?;
        BearerCredential::from_wire(body.access_token, &body.expires_at)
    }

    pub(crate) async fn delete_installation(&self, bearer: &str) -> Result<(), ServiceError> {
        #[cfg(test)]
        if let Some(result) = self.identity_deletion_result.lock().unwrap().take() {
            return result;
        }
        let response = self
            .client
            .delete(self.endpoint(CURRENT_INSTALLATION_PATH)?)
            .bearer_auth(bearer)
            .header(CACHE_CONTROL, "no-store")
            .send()
            .await
            .map_err(|_| ServiceError::Unavailable)?;
        ensure_authenticated_status(&response, &[StatusCode::NO_CONTENT])
    }

    pub(crate) async fn bootstrap_webview_session(
        &self,
        bearer: &str,
        origin: &str,
    ) -> Result<DesktopHttpSession, ServiceError> {
        let response = self
            .client
            .post(self.endpoint(WEBVIEW_SESSIONS_PATH)?)
            .bearer_auth(bearer)
            .header(CACHE_CONTROL, "no-store")
            .json(&DesktopHttpSessionRequest { origin })
            .send()
            .await
            .map_err(|_| ServiceError::Unavailable)?;
        ensure_authenticated_status(&response, &[StatusCode::OK, StatusCode::CREATED])?;
        let session: DesktopHttpSession = decode_json_limited(response).await?;
        session.validate()?;
        Ok(session)
    }

    pub(crate) async fn put_attendance(
        &self,
        bearer: &str,
        snapshot: &AttendanceSnapshot,
    ) -> Result<RemoteAttendanceEnvelope, ServiceError> {
        validate_attendance_snapshot(snapshot)?;
        let response = self
            .client
            .put(self.endpoint(ATTENDANCE_SNAPSHOT_PATH)?)
            .bearer_auth(bearer)
            .json(snapshot)
            .send()
            .await
            .map_err(|_| ServiceError::Unavailable)?;
        ensure_authenticated_status(&response, &[StatusCode::OK, StatusCode::CREATED])?;
        let envelope: RemoteAttendanceEnvelope = decode_json_limited(response).await?;
        validate_remote_attendance(&envelope)?;
        Ok(envelope)
    }

    pub(crate) async fn heartbeat(&self, bearer: &str, state: LmsSessionState) -> Result<(), ServiceError> {
        let response = self
            .client
            .post(self.endpoint(HEARTBEAT_PATH)?)
            .bearer_auth(bearer)
            .json(&Heartbeat {
                lms_session_state: state,
                app_version: env!("CARGO_PKG_VERSION"),
            })
            .send()
            .await
            .map_err(|_| ServiceError::Unavailable)?;
        ensure_authenticated_status(&response, &[StatusCode::OK, StatusCode::NO_CONTENT])
    }

    pub(crate) async fn usage_preference(&self, bearer: &str) -> Result<Option<bool>, ServiceError> {
        #[cfg(test)]
        if let Some(result) = self.usage_preference_get_result.lock().unwrap().take() {
            return result;
        }
        let response = self
            .client
            .get(self.endpoint(USAGE_PREFERENCE_PATH)?)
            .bearer_auth(bearer)
            .header(CACHE_CONTROL, "no-store")
            .send()
            .await
            .map_err(|_| ServiceError::Unavailable)?;
        ensure_authenticated_status(&response, &[StatusCode::OK])?;
        Ok(decode_json_limited::<UsagePreferenceResponse>(response).await?.enabled)
    }

    pub(crate) async fn put_usage_preference(&self, bearer: &str, enabled: bool) -> Result<(), ServiceError> {
        #[cfg(test)]
        {
            if let Some(barrier) = &self.usage_preference_put_barrier {
                barrier.started.notify_one();
                barrier.release.notified().await;
            }
            if let Some(result) = self.usage_preference_put_result.lock().unwrap().take() {
                return match result? {
                    Some(stored) if stored == enabled => Ok(()),
                    _ => Err(ServiceError::InvalidResponse),
                };
            }
        }
        let response = self
            .client
            .put(self.endpoint(USAGE_PREFERENCE_PATH)?)
            .bearer_auth(bearer)
            .header(CACHE_CONTROL, "no-store")
            .json(&UsagePreferenceRequest { enabled })
            .send()
            .await
            .map_err(|_| ServiceError::Unavailable)?;
        ensure_authenticated_status(&response, &[StatusCode::OK])?;
        let stored = decode_json_limited::<UsagePreferenceResponse>(response).await?.enabled;
        if stored == Some(enabled) {
            Ok(())
        } else {
            Err(ServiceError::InvalidResponse)
        }
    }

    pub(crate) async fn record_ui_opened_attempt(&self, bearer: &str) -> Result<(), UiOpenedFailure> {
        #[cfg(test)]
        {
            self.ui_opened_attempt_count
                .fetch_add(1, std::sync::atomic::Ordering::AcqRel);
            let result = self.ui_opened_results.lock().unwrap().pop_front();
            if let Some(result) = result {
                if let Some(barrier) = &self.ui_opened_barrier {
                    barrier.started.notify_one();
                    barrier.release.notified().await;
                }
                return match result {
                    Ok(status) => classify_ui_opened_status(status),
                    Err(error) => Err(UiOpenedFailure {
                        error,
                        retryable: error == ServiceError::Unavailable,
                    }),
                };
            }
        }
        let endpoint = self.endpoint(UI_OPENED_PATH).map_err(|error| UiOpenedFailure {
            error,
            retryable: false,
        })?;
        let response = self
            .client
            .post(endpoint)
            .bearer_auth(bearer)
            .send()
            .await
            .map_err(|_| UiOpenedFailure {
                error: ServiceError::Unavailable,
                retryable: true,
            })?;
        classify_ui_opened_status(response.status())
    }

    pub(crate) async fn notifications(&self, bearer: &str) -> Result<Vec<RemoteNotification>, ServiceError> {
        let response = self
            .client
            .get(self.endpoint(NOTIFICATIONS_PATH)?)
            .bearer_auth(bearer)
            .send()
            .await
            .map_err(|_| ServiceError::Unavailable)?;
        ensure_authenticated_status(&response, &[StatusCode::OK])?;
        let mut envelope: RemoteNotificationEnvelope = decode_json_limited(response).await?;
        validate_notifications(&envelope.notifications)?;
        discard_expired_notifications(&mut envelope.notifications, Utc::now().timestamp_millis());
        Ok(envelope.notifications)
    }

    pub(crate) async fn acknowledge_notification(
        &self,
        bearer: &str,
        notification_id: &str,
        outcome: NotificationAckOutcome,
    ) -> Result<(), ServiceError> {
        if !is_safe_route_segment(notification_id) {
            return Err(ServiceError::Rejected);
        }
        let path = format!("{NOTIFICATIONS_PATH}/{notification_id}/ack");
        let response = self
            .client
            .post(self.endpoint(&path)?)
            .bearer_auth(bearer)
            .json(&NotificationAck {
                outcome,
                occurred_at_epoch_ms: Utc::now().timestamp_millis(),
            })
            .send()
            .await
            .map_err(|_| ServiceError::Unavailable)?;
        ensure_authenticated_status(&response, &[StatusCode::OK, StatusCode::NO_CONTENT])
    }

    pub(crate) async fn send_test_notification(
        &self,
        bearer: &str,
        desktop_delivered: bool,
    ) -> Result<TestNotificationBroadcast, ServiceError> {
        let response = self
            .client
            .post(self.endpoint(&format!("{NOTIFICATIONS_PATH}/test"))?)
            .bearer_auth(bearer)
            .json(&TestNotificationRequest { desktop_delivered })
            .send()
            .await
            .map_err(|_| ServiceError::Unavailable)?;
        ensure_authenticated_status(&response, &[StatusCode::OK, StatusCode::ACCEPTED])?;
        let broadcast: TestNotificationBroadcast = decode_json_limited(response).await?;
        if !is_safe_route_segment(&broadcast.notification_id) || broadcast.queued > 100 {
            return Err(ServiceError::InvalidResponse);
        }
        Ok(broadcast)
    }
}

pub(crate) fn is_canonical_server_path(path: &str) -> bool {
    if path.contains(['?', '#', '\\']) {
        return false;
    }
    if matches!(
        path,
        INSTALLATIONS_PATH
            | CURRENT_INSTALLATION_PATH
            | ROTATE_INSTALLATION_PATH
            | WEBVIEW_SESSIONS_PATH
            | CURRENT_WEBVIEW_SESSION_PATH
            | ATTENDANCE_SNAPSHOT_PATH
            | HEARTBEAT_PATH
            | USAGE_PREFERENCE_PATH
            | NOTIFICATIONS_PATH
            | UI_OPENED_PATH
    ) || path == format!("{NOTIFICATIONS_PATH}/test")
    {
        return true;
    }
    path.strip_prefix(&format!("{NOTIFICATIONS_PATH}/"))
        .and_then(|value| value.strip_suffix("/ack"))
        .is_some_and(is_safe_route_segment)
}

pub(crate) fn ensure_status(response: &Response, expected: &[StatusCode]) -> Result<(), ServiceError> {
    if expected.contains(&response.status()) {
        Ok(())
    } else {
        Err(service_error_for_status(response.status()))
    }
}

pub(crate) fn ensure_authenticated_status(response: &Response, expected: &[StatusCode]) -> Result<(), ServiceError> {
    ensure_status(response, expected)
}

async fn decode_json_limited<T: DeserializeOwned>(response: Response) -> Result<T, ServiceError> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES)
    {
        return Err(ServiceError::InvalidResponse);
    }
    let bytes = response.bytes().await.map_err(|_| ServiceError::Unavailable)?;
    if bytes.len() as u64 > MAX_RESPONSE_BYTES {
        return Err(ServiceError::InvalidResponse);
    }
    serde_json::from_slice(&bytes).map_err(|_| ServiceError::InvalidResponse)
}

fn service_error_for_status(status: StatusCode) -> ServiceError {
    if matches!(status, StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN) {
        ServiceError::AuthenticationRequired
    } else if status.is_server_error() {
        ServiceError::Unavailable
    } else {
        ServiceError::Rejected
    }
}

fn classify_ui_opened_status(status: StatusCode) -> Result<(), UiOpenedFailure> {
    if status == StatusCode::NO_CONTENT {
        Ok(())
    } else if is_retryable_ui_opened_status(status) {
        Err(UiOpenedFailure {
            error: ServiceError::Unavailable,
            retryable: true,
        })
    } else {
        Err(UiOpenedFailure {
            error: service_error_for_status(status),
            retryable: false,
        })
    }
}

fn is_retryable_ui_opened_status(status: StatusCode) -> bool {
    matches!(
        status,
        StatusCode::BAD_GATEWAY | StatusCode::SERVICE_UNAVAILABLE | StatusCode::GATEWAY_TIMEOUT
    )
}

pub(crate) async fn wait_before_ui_opened_retry(delay: Duration) {
    #[cfg(not(test))]
    tokio::time::sleep(delay).await;
    #[cfg(test)]
    {
        let _ = delay;
        tokio::task::yield_now().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEST_BEARER: &str = "jbd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    #[tokio::test]
    async fn ui_opened_accepts_204() {
        let api = RemoteApi::with_ui_opened_results([Ok(StatusCode::NO_CONTENT)]);

        assert_eq!(api.record_ui_opened_attempt(TEST_BEARER).await, Ok(()));
        assert_eq!(api.ui_opened_attempt_count(), 1);
    }

    #[tokio::test]
    async fn ui_opened_marks_only_transport_and_502_503_504_as_retryable() {
        for result in [
            Err(ServiceError::Unavailable),
            Ok(StatusCode::BAD_GATEWAY),
            Ok(StatusCode::SERVICE_UNAVAILABLE),
            Ok(StatusCode::GATEWAY_TIMEOUT),
        ] {
            let api = RemoteApi::with_ui_opened_results([result]);

            let failure = api.record_ui_opened_attempt(TEST_BEARER).await.unwrap_err();
            assert_eq!(failure.error, ServiceError::Unavailable);
            assert!(failure.retryable);
            assert_eq!(api.ui_opened_attempt_count(), 1);
        }
    }

    #[tokio::test]
    async fn ui_opened_marks_500_and_client_errors_as_non_retryable() {
        for (status, expected) in [
            (StatusCode::INTERNAL_SERVER_ERROR, ServiceError::Unavailable),
            (StatusCode::BAD_REQUEST, ServiceError::Rejected),
            (StatusCode::UNAUTHORIZED, ServiceError::AuthenticationRequired),
            (StatusCode::FORBIDDEN, ServiceError::AuthenticationRequired),
        ] {
            let api = RemoteApi::with_ui_opened_results([Ok(status)]);

            let failure = api.record_ui_opened_attempt(TEST_BEARER).await.unwrap_err();
            assert_eq!(failure.error, expected, "{status}");
            assert!(!failure.retryable, "{status}");
            assert_eq!(api.ui_opened_attempt_count(), 1, "{status}");
        }
    }
}
