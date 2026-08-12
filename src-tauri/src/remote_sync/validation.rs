use super::*;

pub(crate) fn validate_pairing(pairing: &MobilePairing, allowed_origin: &Url) -> Result<(), ServiceError> {
    if !is_safe_route_segment(&pairing.pairing_id)
        || !is_manual_pairing_code(&pairing.manual_code)
        || parse_future_timestamp(&pairing.expires_at).is_none()
        || !is_safe_pairing_url(&pairing.qr_payload, &pairing.pairing_id, allowed_origin)
    {
        return Err(ServiceError::InvalidResponse);
    }
    Ok(())
}

pub(crate) fn is_safe_pairing_url(value: &str, pairing_id: &str, allowed_origin: &Url) -> bool {
    if value.len() > 2_048 {
        return false;
    }
    let Ok(url) = Url::parse(value) else {
        return false;
    };
    if url.origin() != allowed_origin.origin()
        || url.path() != "/dashboard.html"
        || url.query().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return false;
    }
    let Some(fragment) = url.fragment() else {
        return false;
    };
    let mut pairing = None;
    let mut challenge = None;
    let mut count = 0;
    for part in fragment.split('&') {
        count += 1;
        let Some((key, value)) = part.split_once('=') else {
            return false;
        };
        match key {
            "pairing" if pairing.is_none() => pairing = Some(value),
            "challenge" if challenge.is_none() => challenge = Some(value),
            _ => return false,
        }
    }
    count == 2
        && pairing == Some(pairing_id)
        && challenge.is_some_and(|value| {
            value.len() == 69
                && value.starts_with("jbpc_")
                && value[5..]
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        })
}

pub(crate) fn validate_pairing_status(status: &MobilePairingStatus) -> Result<(), ServiceError> {
    if !matches!(
        status.status.as_str(),
        "pending" | "claimed" | "approved" | "completed" | "expired"
    ) {
        return Err(ServiceError::InvalidResponse);
    }
    if status.status == "claimed" {
        let Some(claim) = &status.claim else {
            return Err(ServiceError::InvalidResponse);
        };
        if !is_safe_route_segment(&claim.claim_id)
            || !is_safe_notification_text(&claim.device_label, 80, false)
            || claim.confirmation_code.len() != 4
            || !claim.confirmation_code.bytes().all(|byte| byte.is_ascii_alphanumeric())
        {
            return Err(ServiceError::InvalidResponse);
        }
    } else if status.claim.is_some() {
        return Err(ServiceError::InvalidResponse);
    }
    Ok(())
}

pub(crate) fn validate_devices(devices: &[MobileDevice]) -> Result<(), ServiceError> {
    if devices.len() > 100 {
        return Err(ServiceError::InvalidResponse);
    }
    let mut ids = BTreeSet::new();
    for device in devices {
        let timestamps_valid = [&device.created_at, &device.expires_at, &device.last_seen_at]
            .into_iter()
            .all(|value| DateTime::parse_from_rfc3339(value).is_ok());
        if !is_safe_route_segment(&device.device_id)
            || !ids.insert(device.device_id.as_str())
            || !is_safe_notification_text(&device.device_label, 80, false)
            || !is_safe_device_installation_id(&device.installation_id)
            || !timestamps_valid
            || !matches!(device.status.as_str(), "active" | "revoked" | "expired")
        {
            return Err(ServiceError::InvalidResponse);
        }
    }
    Ok(())
}

pub(crate) fn is_safe_device_installation_id(value: &str) -> bool {
    (8..=128).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
}

pub(crate) fn validate_attendance_snapshot(snapshot: &AttendanceSnapshot) -> Result<(), ServiceError> {
    let attendance_date = chrono::NaiveDate::parse_from_str(&snapshot.attendance_date, "%Y-%m-%d")
        .map_err(|_| ServiceError::InvalidResponse)?;
    let cohort_start = snapshot
        .cohort_start_date
        .as_deref()
        .map(|value| chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d"))
        .transpose()
        .map_err(|_| ServiceError::InvalidResponse)?;
    let cohort_end = snapshot
        .cohort_end_date
        .as_deref()
        .map(|value| chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d"))
        .transpose()
        .map_err(|_| ServiceError::InvalidResponse)?;
    if cohort_start.zip(cohort_end).is_some_and(|(start, end)| start > end)
        || snapshot
            .cohort_id
            .as_deref()
            .is_some_and(|id| id.is_empty() || id.len() > 128 || id.trim() != id || id.chars().any(char::is_control))
        || DateTime::parse_from_rfc3339(&snapshot.collected_at).is_err()
    {
        return Err(ServiceError::InvalidResponse);
    }

    let coherent = match snapshot.cohort_status {
        AttendanceCohortStatus::Active => snapshot.cohort_id.is_some(),
        AttendanceCohortStatus::Upcoming | AttendanceCohortStatus::Ended => {
            snapshot.cohort_id.is_none() && !snapshot.morning_checked && !snapshot.evening_checked
        }
        AttendanceCohortStatus::None => {
            snapshot.cohort_id.is_none()
                && cohort_start.is_none()
                && cohort_end.is_none()
                && !snapshot.morning_checked
                && !snapshot.evening_checked
        }
        AttendanceCohortStatus::Unknown => snapshot.cohort_id.is_none(),
    };
    if !coherent || attendance_date.year() < 2020 {
        return Err(ServiceError::InvalidResponse);
    }
    Ok(())
}

pub(crate) fn validate_remote_attendance(envelope: &RemoteAttendanceEnvelope) -> Result<(), ServiceError> {
    match (&envelope.attendance, envelope.freshness) {
        (Some(snapshot), RemoteAttendanceFreshness::Fresh | RemoteAttendanceFreshness::Stale) => {
            validate_attendance_snapshot(snapshot)?;
        }
        (None, RemoteAttendanceFreshness::Missing) => {}
        _ => return Err(ServiceError::InvalidResponse),
    }
    Ok(())
}

pub(crate) fn validate_notifications(notifications: &[RemoteNotification]) -> Result<(), ServiceError> {
    if notifications.len() > MAX_NOTIFICATION_DELIVERIES {
        return Err(ServiceError::InvalidResponse);
    }
    let mut ids = BTreeSet::new();
    for notification in notifications {
        if !is_safe_route_segment(&notification.id)
            || !ids.insert(notification.id.as_str())
            || !is_safe_notification_text(&notification.title, 80, false)
            || !is_safe_notification_text(&notification.body, 500, true)
            || !is_safe_relative_path(&notification.path)
            || notification.created_at_epoch_ms < 0
            || notification.expires_at_epoch_ms < notification.created_at_epoch_ms
            || !(1..=100).contains(&notification.attempt)
        {
            return Err(ServiceError::InvalidResponse);
        }
    }
    Ok(())
}

pub(crate) fn discard_expired_notifications(notifications: &mut Vec<RemoteNotification>, now_epoch_ms: i64) {
    notifications.retain(|notification| notification.expires_at_epoch_ms > now_epoch_ms);
}

pub(crate) fn is_safe_relative_path(value: &str) -> bool {
    value.starts_with('/')
        && !value.starts_with("//")
        && value.len() <= 512
        && !value.contains(['\\', '\0', '\n', '\r'])
}

pub(crate) fn validate_meal_preferences(preferences: &MealPreferences) -> Result<(), ServiceError> {
    if preferences.updated_at_epoch_ms < 0 {
        return Err(ServiceError::InvalidResponse);
    }
    Ok(())
}

pub(crate) fn validate_attendance_preferences(preferences: &AttendancePreferences) -> Result<(), ServiceError> {
    const ALLOWED_INTERVALS: [u8; 6] = [1, 3, 5, 10, 15, 30];
    if !(4..=9).contains(&preferences.morning_start_hour)
        || preferences.evening_end_hour > 4
        || !ALLOWED_INTERVALS.contains(&preferences.morning_interval_minutes)
        || !ALLOWED_INTERVALS.contains(&preferences.evening_interval_minutes)
        || preferences
            .skip_attendance_date
            .as_deref()
            .is_some_and(|value| chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d").is_err())
    {
        return Err(ServiceError::Rejected);
    }
    Ok(())
}

pub(crate) fn validate_machine_id(value: &str, allow_empty: bool) -> Result<(), ServiceError> {
    if allow_empty && value.is_empty() {
        return Ok(());
    }
    if !(1..=128).contains(&value.len()) || value.trim() != value || value.chars().any(char::is_control) {
        return Err(ServiceError::Rejected);
    }
    Ok(())
}

fn validate_session_id(value: &str) -> Result<(), ServiceError> {
    if !(1..=256).contains(&value.len()) || value.trim() != value || value.chars().any(char::is_control) {
        return Err(ServiceError::Rejected);
    }
    Ok(())
}

pub(crate) fn is_laundry_resource_id(value: &str, prefix: &str) -> bool {
    matches!(prefix, "jbw_" | "jbq_")
        && value.len() == prefix.len() + 64
        && value.starts_with(prefix)
        && value[prefix.len()..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

pub(crate) fn validate_laundry_watch_input(input: &LaundryWatchInput) -> Result<(), ServiceError> {
    validate_machine_id(&input.machine_id, false)?;
    if input
        .session_id
        .as_deref()
        .is_some_and(|value| validate_session_id(value).is_err())
        || input.notify_before_minutes > 180
    {
        return Err(ServiceError::Rejected);
    }
    Ok(())
}

pub(crate) fn validate_laundry_watch(watch: &RemoteLaundryWatch) -> Result<(), ServiceError> {
    validate_machine_id(&watch.machine_id, false).map_err(|_| ServiceError::InvalidResponse)?;
    if !is_laundry_resource_id(&watch.id, "jbw_")
        || watch
            .session_id
            .as_deref()
            .is_some_and(|value| validate_session_id(value).is_err())
        || watch.notify_before_minutes > 180
        || watch.created_at_epoch_ms < 0
        || watch.updated_at_epoch_ms < watch.created_at_epoch_ms
    {
        return Err(ServiceError::InvalidResponse);
    }
    Ok(())
}

pub(crate) fn validate_laundry_watches(envelope: &LaundryWatchEnvelope) -> Result<(), ServiceError> {
    if envelope.watches.len() > MAX_LAUNDRY_WATCHES {
        return Err(ServiceError::InvalidResponse);
    }
    let mut ids = BTreeSet::new();
    for watch in &envelope.watches {
        validate_laundry_watch(watch)?;
        if !ids.insert(watch.id.as_str()) {
            return Err(ServiceError::InvalidResponse);
        }
    }
    Ok(())
}

pub(crate) fn validate_laundry_queue_input(input: &LaundryQueueInput) -> Result<(), ServiceError> {
    if let Some(machine_id) = &input.machine_id {
        validate_machine_id(machine_id, false)?;
    }
    Ok(())
}

pub(crate) fn validate_laundry_queue_entry(entry: &LaundryQueueEntry) -> Result<(), ServiceError> {
    if let Some(machine_id) = &entry.machine_id {
        validate_machine_id(machine_id, false).map_err(|_| ServiceError::InvalidResponse)?;
    }
    if !is_laundry_resource_id(&entry.id, "jbq_")
        || entry.joined_at_epoch_ms < 0
        || entry
            .left_at_epoch_ms
            .is_some_and(|left_at| left_at < entry.joined_at_epoch_ms)
        || entry.position == Some(0)
    {
        return Err(ServiceError::InvalidResponse);
    }
    Ok(())
}

pub(crate) fn validate_laundry_queue(envelope: &LaundryQueueEnvelope) -> Result<(), ServiceError> {
    if envelope.entries.len() > MAX_LAUNDRY_QUEUE_ENTRIES {
        return Err(ServiceError::InvalidResponse);
    }
    let mut ids = BTreeSet::new();
    for entry in &envelope.entries {
        validate_laundry_queue_entry(entry)?;
        if !ids.insert(entry.id.as_str()) {
            return Err(ServiceError::InvalidResponse);
        }
    }
    Ok(())
}
