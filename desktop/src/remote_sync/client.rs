use super::*;
use reqwest::header::CACHE_CONTROL;

#[derive(Clone)]
pub(crate) struct RemoteApi {
    origin: Url,
    client: Client,
    #[cfg(test)]
    rotation_result: Arc<std::sync::Mutex<Option<Result<BearerCredential, ServiceError>>>>,
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
        })
    }

    #[cfg(test)]
    pub(crate) fn with_rotation_result(result: Result<BearerCredential, ServiceError>) -> Self {
        let mut api = Self::new("https://bell.example.com").unwrap();
        api.rotation_result = Arc::new(std::sync::Mutex::new(Some(result)));
        api
    }

    pub(crate) fn endpoint(&self, path: &str) -> Result<Url, ServiceError> {
        if !is_canonical_server_path(path) {
            return Err(ServiceError::Rejected);
        }
        self.origin.join(path).map_err(|_| ServiceError::InvalidResponse)
    }

    pub(crate) async fn register_installation(&self, installation_id: &str) -> Result<BearerCredential, ServiceError> {
        let response = self
            .client
            .post(self.endpoint(INSTALLATIONS_PATH)?)
            .json(&DesktopInstallationRequest {
                installation_id: installation_id.to_owned(),
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

    pub(crate) async fn revoke_webview_session(&self, bearer: &str, origin: &str) -> Result<(), ServiceError> {
        let response = self
            .client
            .delete(self.endpoint(CURRENT_WEBVIEW_SESSION_PATH)?)
            .bearer_auth(bearer)
            .header(CACHE_CONTROL, "no-store")
            .json(&DesktopHttpSessionRequest { origin })
            .send()
            .await
            .map_err(|_| ServiceError::Unavailable)?;
        ensure_authenticated_status(&response, &[StatusCode::NO_CONTENT])
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
            | ROTATE_INSTALLATION_PATH
            | WEBVIEW_SESSIONS_PATH
            | CURRENT_WEBVIEW_SESSION_PATH
            | ATTENDANCE_SNAPSHOT_PATH
            | HEARTBEAT_PATH
            | NOTIFICATIONS_PATH
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
    } else if matches!(response.status(), StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN) {
        Err(ServiceError::AuthenticationRequired)
    } else if response.status().is_server_error() {
        Err(ServiceError::Unavailable)
    } else {
        Err(ServiceError::Rejected)
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
