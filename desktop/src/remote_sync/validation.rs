use super::*;

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
            || notification.attempt > 100
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
