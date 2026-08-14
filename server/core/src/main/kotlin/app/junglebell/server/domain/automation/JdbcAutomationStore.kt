package app.junglebell.server.domain.automation

import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.stereotype.Repository
import org.springframework.transaction.annotation.Transactional
import java.time.Instant
import java.util.UUID

@Repository
class JdbcAutomationStore(private val jdbc: JdbcClient) : AutomationStore {
    override fun tryAcquireLease(name: String, now: Long, durationMs: Long, token: String): Boolean = jdbc.sql(
        """
        INSERT INTO maintenance_state(name, last_run_at_epoch_ms, run_token)
        VALUES (:name, :now, :token)
        ON CONFLICT (name) DO UPDATE
        SET last_run_at_epoch_ms = EXCLUDED.last_run_at_epoch_ms,
            run_token = EXCLUDED.run_token
        WHERE maintenance_state.last_run_at_epoch_ms <= :expiresBefore
        RETURNING run_token
        """.trimIndent(),
    ).param("name", name).param("now", now).param("token", token)
        .param("expiresBefore", now - durationMs).query(String::class.java).optional().isPresent

    @Transactional
    override fun runHousekeepingIfDue(
        name: String,
        now: Long,
        durationMs: Long,
        token: String,
    ): Map<String, Int>? {
        if (!tryAcquireLease(name, now, durationMs, token)) return null
        return runHousekeeping(now)
    }

    override fun attendancePreferences(): List<AttendanceCandidate> = jdbc.sql(
        """
        SELECT preference.*, snapshot.attendance_date, snapshot.cohort_status,
               snapshot.morning_checked, snapshot.evening_checked,
               snapshot.collected_at_epoch_ms
        FROM attendance_preference preference
        LEFT JOIN attendance_snapshot snapshot ON snapshot.user_id = preference.user_id
        WHERE preference.enabled
        ORDER BY preference.user_id
        """.trimIndent(),
    ).query { row, _ ->
        AttendanceCandidate(
            userId = row.getObject("user_id", UUID::class.java),
            morning = row.getBoolean("morning_enabled"),
            evening = row.getBoolean("evening_enabled"),
            morningStartHour = row.getInt("morning_start_hour"),
            eveningEndHour = row.getInt("evening_end_hour"),
            morningIntervalMinutes = row.getInt("morning_interval_minutes"),
            eveningIntervalMinutes = row.getInt("evening_interval_minutes"),
            skipSunday = row.getBoolean("skip_sunday"),
            skipAttendanceDate = row.getDate("skip_attendance_date")?.toLocalDate()?.toString(),
            attendanceDate = row.getDate("attendance_date")?.toLocalDate()?.toString(),
            cohortStatus = row.getString("cohort_status"),
            morningChecked = row.getObject("morning_checked")?.let { row.getBoolean("morning_checked") },
            eveningChecked = row.getObject("evening_checked")?.let { row.getBoolean("evening_checked") },
            collectedAtEpochMs = row.getObject("collected_at_epoch_ms")?.let { row.getLong("collected_at_epoch_ms") },
        )
    }.list()

    override fun desktopStates(userId: UUID): List<DesktopState> = jdbc.sql(
        """
        SELECT last_seen_at_epoch_ms, lms_session_state
        FROM desktop_device
        WHERE user_id = :userId
        ORDER BY installation_id
        """.trimIndent(),
    ).param("userId", userId).query { row, _ ->
        DesktopState(
            row.getObject("last_seen_at_epoch_ms")?.let { row.getLong("last_seen_at_epoch_ms") },
            row.getString("lms_session_state"),
        )
    }.list()

    override fun recentMealPublications(since: Instant): List<MealPublication> = jdbc.sql(
        """
        SELECT id, content_sha, title, body, published_at, updated_at,
               first_seen_at, content_first_seen_at
        FROM meal_post
        WHERE content_first_seen_at >= :since
        ORDER BY content_first_seen_at, id
        LIMIT 200
        """.trimIndent(),
    ).param("since", java.sql.Timestamp.from(since)).query { row, _ ->
        MealPublication(
            id = row.getString("id"),
            contentSha = row.getString("content_sha"),
            title = row.getString("title"),
            body = row.getString("body"),
            publishedAt = row.getTimestamp("published_at")?.toInstant(),
            updatedAt = row.getTimestamp("updated_at")?.toInstant(),
            firstSeenAt = row.getTimestamp("first_seen_at").toInstant(),
            contentFirstSeenAt = row.getTimestamp("content_first_seen_at").toInstant(),
        )
    }.list()

    override fun mealSubscriberUserIds(period: String): List<UUID> {
        require(period == "lunch" || period == "dinner")
        return jdbc.sql(
            "SELECT user_id FROM meal_preference WHERE enabled AND $period ORDER BY user_id",
        ).query { row, _ -> row.getObject(1, UUID::class.java)!! }.list()
    }

    override fun activeLaundryWatches(): List<ActiveLaundryWatch> = jdbc.sql(
        """
        SELECT id, user_id, machine_id, appliance, session_id,
               notify_before_minutes, notify_when_available
        FROM laundry_watch
        WHERE status = 'active'
        ORDER BY created_at_epoch_ms, id
        """.trimIndent(),
    ).query { row, _ ->
        ActiveLaundryWatch(
            id = row.getString("id"),
            userId = row.getObject("user_id", UUID::class.java),
            machineId = row.getString("machine_id"),
            appliance = row.getString("appliance"),
            sessionId = row.getString("session_id"),
            notifyBeforeMinutes = row.getInt("notify_before_minutes"),
            notifyWhenAvailable = row.getBoolean("notify_when_available"),
        )
    }.list()

    override fun completeLaundryWatch(id: String, now: Long): Boolean = jdbc.sql(
        """
        UPDATE laundry_watch
        SET status = 'completed', updated_at_epoch_ms = :now
        WHERE id = :id AND status = 'active'
        RETURNING id
        """.trimIndent(),
    ).param("now", now).param("id", id).query(String::class.java).optional().isPresent

    override fun claimPushDeliveries(now: Long, leaseToken: String, limit: Int): List<PushDelivery> = jdbc.sql(
        """
        WITH candidates AS (
            SELECT delivery.notification_id, delivery.target_id
            FROM notification_delivery delivery
            JOIN notification ON notification.id = delivery.notification_id
            WHERE delivery.target_kind = 'push'
              AND delivery.status IN ('pending', 'retry')
              AND COALESCE(delivery.next_attempt_at_epoch_ms, notification.due_at_epoch_ms) <= :now
              AND notification.expires_at_epoch_ms > :now
              AND (delivery.lease_expires_at_epoch_ms IS NULL OR delivery.lease_expires_at_epoch_ms <= :now)
            ORDER BY COALESCE(delivery.next_attempt_at_epoch_ms, notification.due_at_epoch_ms),
                     notification.created_at_epoch_ms
            FOR UPDATE OF delivery SKIP LOCKED
            LIMIT :limit
        ), leased AS (
            UPDATE notification_delivery delivery
            SET lease_token = :leaseToken, lease_expires_at_epoch_ms = :leaseExpiresAt
            FROM candidates
            WHERE delivery.notification_id = candidates.notification_id
              AND delivery.target_kind = 'push'
              AND delivery.target_id = candidates.target_id
            RETURNING delivery.notification_id, delivery.target_id, delivery.attempts
        )
        SELECT leased.notification_id, leased.target_id, leased.attempts,
               notification.payload::text AS payload_json,
               notification.expires_at_epoch_ms,
               push.endpoint, push.p256dh, push.auth
        FROM leased
        JOIN notification ON notification.id = leased.notification_id
        JOIN push_subscription push ON push.id = leased.target_id
        JOIN app_session session ON session.id = push.session_id
        WHERE push.revoked_at_epoch_ms IS NULL
          AND session.revoked_at_epoch_ms IS NULL
          AND session.expires_at_epoch_ms > :now
        ORDER BY notification.created_at_epoch_ms
        """.trimIndent(),
    ).param("now", now).param("limit", limit).param("leaseToken", leaseToken)
        .param("leaseExpiresAt", now + 60_000).query { row, _ ->
            PushDelivery(
                notificationId = row.getObject("notification_id", UUID::class.java),
                subscriptionId = row.getString("target_id"),
                attempts = row.getInt("attempts"),
                payloadJson = row.getString("payload_json"),
                expiresAtEpochMs = row.getLong("expires_at_epoch_ms"),
                endpoint = row.getString("endpoint"),
                p256dh = row.getString("p256dh"),
                auth = row.getString("auth"),
            )
        }.list()

    override fun settlePush(
        delivery: PushDelivery,
        leaseToken: String,
        status: String,
        now: Long,
        nextAttemptAt: Long?,
        error: String?,
    ): Boolean = jdbc.sql(
        """
        WITH settled AS (
            UPDATE notification_delivery
            SET status = :status,
                attempts = attempts + 1,
                next_attempt_at_epoch_ms = :nextAttemptAt,
                last_error = :error,
                delivered_at_epoch_ms = CASE WHEN :status = 'delivered' THEN :now ELSE delivered_at_epoch_ms END,
                lease_token = NULL,
                lease_expires_at_epoch_ms = NULL
            WHERE notification_id = :notificationId
              AND target_kind = 'push'
              AND target_id = :subscriptionId
              AND lease_token = :leaseToken
            RETURNING target_id
        ), revoked AS (
            UPDATE push_subscription push
            SET revoked_at_epoch_ms = :now
            FROM settled
            WHERE :status = 'gone' AND push.id = settled.target_id
              AND push.revoked_at_epoch_ms IS NULL
            RETURNING push.id
        )
        SELECT target_id FROM settled
        """.trimIndent(),
    ).param("status", status).param("nextAttemptAt", nextAttemptAt).param("error", error)
        .param("now", now).param("notificationId", delivery.notificationId)
        .param("subscriptionId", delivery.subscriptionId).param("leaseToken", leaseToken)
        .query(String::class.java).optional().isPresent

    private fun runHousekeeping(now: Long): Map<String, Int> = linkedMapOf(
        "desktopUiSessions" to jdbc.sql("DELETE FROM desktop_ui_session WHERE expires_at_epoch_ms <= :now")
            .param("now", now).update(),
        "pairingChallenges" to jdbc.sql("DELETE FROM pairing_challenge WHERE expires_at_epoch_ms <= :cutoff")
            .param("cutoff", now - 24 * 60 * 60_000L).update(),
        "enrollmentAttempts" to jdbc.sql("DELETE FROM desktop_enrollment_attempt WHERE window_started_at_epoch_ms <= :cutoff")
            .param("cutoff", now - 24 * 60 * 60_000L).update(),
        "notifications" to jdbc.sql("DELETE FROM notification WHERE expires_at_epoch_ms <= :cutoff")
            .param("cutoff", now - 30L * 24 * 60 * 60_000).update(),
    )
}
