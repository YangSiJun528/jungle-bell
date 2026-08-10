use super::*;

#[derive(Clone)]
pub(crate) struct RemoteApi {
    origin: Url,
    client: Client,
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
        Ok(Self { origin, client })
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

    pub(crate) async fn create_pairing(&self, bearer: &str) -> Result<MobilePairing, ServiceError> {
        let response = self
            .client
            .post(self.endpoint(PAIRINGS_PATH)?)
            .bearer_auth(bearer)
            .json(&serde_json::json!({}))
            .send()
            .await
            .map_err(|_| ServiceError::Unavailable)?;
        ensure_authenticated_status(&response, &[StatusCode::OK, StatusCode::CREATED])?;
        let pairing: MobilePairing = decode_json_limited(response).await?;
        validate_pairing(&pairing, &self.origin)?;
        Ok(pairing)
    }

    pub(crate) async fn get_pairing_status(
        &self,
        bearer: &str,
        pairing_id: &str,
    ) -> Result<MobilePairingStatus, ServiceError> {
        let path = pairing_path(pairing_id, "")?;
        let response = self
            .client
            .get(self.endpoint(&path)?)
            .bearer_auth(bearer)
            .send()
            .await
            .map_err(|_| ServiceError::Unavailable)?;
        ensure_authenticated_status(&response, &[StatusCode::OK])?;
        let status: MobilePairingStatus = decode_json_limited(response).await?;
        validate_pairing_status(&status)?;
        Ok(status)
    }

    pub(crate) async fn approve_pairing(&self, bearer: &str, pairing_id: &str) -> Result<(), ServiceError> {
        let path = pairing_path(pairing_id, "/approve")?;
        let response = self
            .client
            .post(self.endpoint(&path)?)
            .bearer_auth(bearer)
            .json(&serde_json::json!({}))
            .send()
            .await
            .map_err(|_| ServiceError::Unavailable)?;
        ensure_authenticated_status(&response, &[StatusCode::OK, StatusCode::NO_CONTENT])
    }

    pub(crate) async fn list_devices(&self, bearer: &str) -> Result<Vec<MobileDevice>, ServiceError> {
        let response = self
            .client
            .get(self.endpoint(MOBILE_SESSIONS_PATH)?)
            .bearer_auth(bearer)
            .send()
            .await
            .map_err(|_| ServiceError::Unavailable)?;
        ensure_authenticated_status(&response, &[StatusCode::OK])?;
        let envelope: MobileDeviceEnvelope = decode_json_limited(response).await?;
        validate_devices(&envelope.devices)?;
        Ok(envelope.devices)
    }

    pub(crate) async fn revoke_device(&self, bearer: &str, device_id: &str) -> Result<(), ServiceError> {
        let path = device_path(device_id)?;
        let response = self
            .client
            .delete(self.endpoint(&path)?)
            .bearer_auth(bearer)
            .send()
            .await
            .map_err(|_| ServiceError::Unavailable)?;
        ensure_authenticated_status(&response, &[StatusCode::OK, StatusCode::NO_CONTENT])
    }

    pub(crate) async fn get_meal_preferences(&self, bearer: &str) -> Result<MealPreferences, ServiceError> {
        let response = self
            .client
            .get(self.endpoint(MEAL_PREFERENCES_PATH)?)
            .bearer_auth(bearer)
            .send()
            .await
            .map_err(|_| ServiceError::Unavailable)?;
        ensure_authenticated_status(&response, &[StatusCode::OK])?;
        let preferences: MealPreferences = decode_json_limited(response).await?;
        validate_meal_preferences(&preferences)?;
        Ok(preferences)
    }

    pub(crate) async fn put_meal_preferences(
        &self,
        bearer: &str,
        input: &MealPreferencesInput,
    ) -> Result<MealPreferences, ServiceError> {
        let response = self
            .client
            .put(self.endpoint(MEAL_PREFERENCES_PATH)?)
            .bearer_auth(bearer)
            .json(input)
            .send()
            .await
            .map_err(|_| ServiceError::Unavailable)?;
        ensure_authenticated_status(&response, &[StatusCode::OK])?;
        let preferences: MealPreferences = decode_json_limited(response).await?;
        validate_meal_preferences(&preferences)?;
        Ok(preferences)
    }

    pub(crate) async fn list_laundry_watches(&self, bearer: &str) -> Result<LaundryWatchEnvelope, ServiceError> {
        let response = self
            .client
            .get(self.endpoint(LAUNDRY_WATCHES_PATH)?)
            .bearer_auth(bearer)
            .send()
            .await
            .map_err(|_| ServiceError::Unavailable)?;
        ensure_authenticated_status(&response, &[StatusCode::OK])?;
        let envelope: LaundryWatchEnvelope = decode_json_limited(response).await?;
        validate_laundry_watches(&envelope)?;
        Ok(envelope)
    }

    pub(crate) async fn create_laundry_watch(
        &self,
        bearer: &str,
        input: &LaundryWatchInput,
    ) -> Result<RemoteLaundryWatch, ServiceError> {
        validate_laundry_watch_input(input)?;
        let response = self
            .client
            .post(self.endpoint(LAUNDRY_WATCHES_PATH)?)
            .bearer_auth(bearer)
            .json(input)
            .send()
            .await
            .map_err(|_| ServiceError::Unavailable)?;
        let response = ensure_shared_control_response(
            response,
            &[StatusCode::CREATED],
            &[
                SharedControlErrorCode::WatchAlreadyExists,
                SharedControlErrorCode::WatchLimitReached,
            ],
        )
        .await?;
        let watch: RemoteLaundryWatch = decode_json_limited(response).await?;
        validate_laundry_watch(&watch)?;
        Ok(watch)
    }

    pub(crate) async fn delete_laundry_watch(&self, bearer: &str, watch_id: &str) -> Result<(), ServiceError> {
        let path = laundry_resource_path(LAUNDRY_WATCHES_PATH, watch_id, "jbw_")?;
        let response = self
            .client
            .delete(self.endpoint(&path)?)
            .bearer_auth(bearer)
            .send()
            .await
            .map_err(|_| ServiceError::Unavailable)?;
        ensure_shared_control_response(
            response,
            &[StatusCode::NO_CONTENT],
            &[SharedControlErrorCode::WatchNotFound],
        )
        .await
        .map(drop)
    }

    pub(crate) async fn list_laundry_queue(&self, bearer: &str) -> Result<LaundryQueueEnvelope, ServiceError> {
        let response = self
            .client
            .get(self.endpoint(LAUNDRY_QUEUE_PATH)?)
            .bearer_auth(bearer)
            .send()
            .await
            .map_err(|_| ServiceError::Unavailable)?;
        ensure_authenticated_status(&response, &[StatusCode::OK])?;
        let envelope: LaundryQueueEnvelope = decode_json_limited(response).await?;
        validate_laundry_queue(&envelope)?;
        Ok(envelope)
    }

    pub(crate) async fn join_laundry_queue(
        &self,
        bearer: &str,
        input: &LaundryQueueInput,
    ) -> Result<LaundryQueueEntry, ServiceError> {
        validate_laundry_queue_input(input)?;
        let response = self
            .client
            .post(self.endpoint(LAUNDRY_QUEUE_PATH)?)
            .bearer_auth(bearer)
            .json(input)
            .send()
            .await
            .map_err(|_| ServiceError::Unavailable)?;
        let response = ensure_shared_control_response(
            response,
            &[StatusCode::CREATED],
            &[SharedControlErrorCode::QueueAlreadyJoined],
        )
        .await?;
        let entry: LaundryQueueEntry = decode_json_limited(response).await?;
        validate_laundry_queue_entry(&entry)?;
        Ok(entry)
    }

    pub(crate) async fn leave_laundry_queue(&self, bearer: &str, entry_id: &str) -> Result<(), ServiceError> {
        let path = laundry_resource_path(LAUNDRY_QUEUE_PATH, entry_id, "jbq_")?;
        let response = self
            .client
            .delete(self.endpoint(&path)?)
            .bearer_auth(bearer)
            .send()
            .await
            .map_err(|_| ServiceError::Unavailable)?;
        ensure_shared_control_response(
            response,
            &[StatusCode::NO_CONTENT],
            &[SharedControlErrorCode::QueueEntryNotFound],
        )
        .await
        .map(drop)
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

    pub(crate) async fn get_attendance(&self, bearer: &str) -> Result<RemoteAttendanceEnvelope, ServiceError> {
        let response = self
            .client
            .get(self.endpoint(ATTENDANCE_SNAPSHOT_PATH)?)
            .bearer_auth(bearer)
            .send()
            .await
            .map_err(|_| ServiceError::Unavailable)?;
        ensure_authenticated_status(&response, &[StatusCode::OK])?;
        let envelope: RemoteAttendanceEnvelope = decode_json_limited(response).await?;
        validate_remote_attendance(&envelope)?;
        Ok(envelope)
    }

    pub(crate) async fn get_attendance_preferences(&self, bearer: &str) -> Result<AttendancePreferences, ServiceError> {
        let response = self
            .client
            .get(self.endpoint(ATTENDANCE_PREFERENCES_PATH)?)
            .bearer_auth(bearer)
            .send()
            .await
            .map_err(|_| ServiceError::Unavailable)?;
        ensure_authenticated_status(&response, &[StatusCode::OK])?;
        let preferences: AttendancePreferences = decode_json_limited(response).await?;
        validate_attendance_preferences(&preferences).map_err(|_| ServiceError::InvalidResponse)?;
        Ok(preferences)
    }

    pub(crate) async fn put_attendance_preferences(
        &self,
        bearer: &str,
        input: &AttendancePreferences,
    ) -> Result<AttendancePreferences, ServiceError> {
        validate_attendance_preferences(input)?;
        let response = self
            .client
            .put(self.endpoint(ATTENDANCE_PREFERENCES_PATH)?)
            .bearer_auth(bearer)
            .json(input)
            .send()
            .await
            .map_err(|_| ServiceError::Unavailable)?;
        ensure_authenticated_status(&response, &[StatusCode::OK])?;
        let preferences: AttendancePreferences = decode_json_limited(response).await?;
        validate_attendance_preferences(&preferences).map_err(|_| ServiceError::InvalidResponse)?;
        Ok(preferences)
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
            | ATTENDANCE_SNAPSHOT_PATH
            | ATTENDANCE_PREFERENCES_PATH
            | HEARTBEAT_PATH
            | NOTIFICATIONS_PATH
            | MOBILE_SESSIONS_PATH
            | MEAL_PREFERENCES_PATH
            | LAUNDRY_WATCHES_PATH
            | LAUNDRY_QUEUE_PATH
            | PAIRINGS_PATH
    ) || path == format!("{NOTIFICATIONS_PATH}/test")
    {
        return true;
    }
    if let Some(value) = path.strip_prefix(&format!("{NOTIFICATIONS_PATH}/")) {
        return value.strip_suffix("/ack").is_some_and(is_safe_route_segment);
    }
    if let Some(value) = path.strip_prefix(&format!("{MOBILE_SESSIONS_PATH}/")) {
        return is_safe_route_segment(value);
    }
    if let Some(value) = path.strip_prefix(&format!("{LAUNDRY_WATCHES_PATH}/")) {
        return is_laundry_resource_id(value, "jbw_");
    }
    if let Some(value) = path.strip_prefix(&format!("{LAUNDRY_QUEUE_PATH}/")) {
        return is_laundry_resource_id(value, "jbq_");
    }
    if let Some(value) = path.strip_prefix(&format!("{PAIRINGS_PATH}/")) {
        return value
            .strip_suffix("/approve")
            .map_or_else(|| is_safe_route_segment(value), is_safe_route_segment);
    }
    false
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

async fn ensure_shared_control_response(
    response: Response,
    expected: &[StatusCode],
    allowed_errors: &[SharedControlErrorCode],
) -> Result<Response, ServiceError> {
    if expected.contains(&response.status()) {
        return Ok(response);
    }
    if matches!(response.status(), StatusCode::NOT_FOUND | StatusCode::CONFLICT) {
        let error: SharedControlError = decode_json_limited(response).await?;
        return if allowed_errors.contains(&error.error) {
            Err(ServiceError::from(error.error))
        } else {
            Err(ServiceError::InvalidResponse)
        };
    }
    ensure_authenticated_status(&response, expected)?;
    Ok(response)
}

pub(crate) fn pairing_path(pairing_id: &str, suffix: &str) -> Result<String, ServiceError> {
    if !is_safe_route_segment(pairing_id) || !matches!(suffix, "" | "/approve") {
        return Err(ServiceError::Rejected);
    }
    Ok(format!("{PAIRINGS_PATH}/{pairing_id}{suffix}"))
}

pub(crate) fn device_path(device_id: &str) -> Result<String, ServiceError> {
    if !is_safe_route_segment(device_id) {
        return Err(ServiceError::Rejected);
    }
    Ok(format!("{MOBILE_SESSIONS_PATH}/{device_id}"))
}

pub(crate) fn laundry_resource_path(
    collection_path: &str,
    resource_id: &str,
    prefix: &str,
) -> Result<String, ServiceError> {
    if !matches!(collection_path, LAUNDRY_WATCHES_PATH | LAUNDRY_QUEUE_PATH)
        || !is_laundry_resource_id(resource_id, prefix)
        || (collection_path == LAUNDRY_WATCHES_PATH) != (prefix == "jbw_")
    {
        return Err(ServiceError::Rejected);
    }
    Ok(format!("{collection_path}/{resource_id}"))
}
