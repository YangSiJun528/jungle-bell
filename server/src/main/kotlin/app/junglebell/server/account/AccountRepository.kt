package app.junglebell.server.account

import app.junglebell.server.security.SessionPrincipal
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.stereotype.Repository
import java.sql.Date
import java.util.UUID

@Repository
class AccountRepository(private val jdbc: JdbcClient) {
    fun consumeEnrollmentAttempt(
        rateKey: String,
        now: Long,
        windowMs: Long,
        attemptLimit: Int,
    ): Boolean = jdbc.sql(
        """
        INSERT INTO desktop_enrollment_attempt(rate_key, window_started_at_epoch_ms, attempt_count)
        VALUES (:rateKey, :now, 1)
        ON CONFLICT(rate_key) DO UPDATE SET
          window_started_at_epoch_ms = CASE
            WHEN :now - desktop_enrollment_attempt.window_started_at_epoch_ms >= :windowMs THEN :now
            ELSE desktop_enrollment_attempt.window_started_at_epoch_ms
          END,
          attempt_count = CASE
            WHEN :now - desktop_enrollment_attempt.window_started_at_epoch_ms >= :windowMs THEN 1
            ELSE desktop_enrollment_attempt.attempt_count + 1
          END
        WHERE :now - desktop_enrollment_attempt.window_started_at_epoch_ms >= :windowMs
          OR desktop_enrollment_attempt.attempt_count < :attemptLimit
        """.trimIndent(),
    ).param("rateKey", rateKey).param("now", now).param("windowMs", windowMs)
        .param("attemptLimit", attemptLimit).update() == 1

    fun desktopExists(installationId: String): Boolean = jdbc.sql(
        "SELECT EXISTS(SELECT 1 FROM desktop_device WHERE installation_id = :installationId)",
    ).param("installationId", installationId).query(Boolean::class.java).single()

    fun createDesktop(
        userId: UUID,
        installationId: String,
        sessionId: UUID,
        tokenHash: String,
        now: Long,
        expiresAt: Long,
    ) {
        jdbc.sql("INSERT INTO app_user(id, created_at_epoch_ms) VALUES (:id, :now)")
            .param("id", userId).param("now", now).update()
        jdbc.sql(
            """
            INSERT INTO desktop_device(
                installation_id, user_id, created_at_epoch_ms, activated_at_epoch_ms,
                last_seen_at_epoch_ms, lms_session_state, app_version
            ) VALUES (:installationId, :userId, :now, :now, :now, 'unknown', NULL)
            """.trimIndent(),
        ).param("installationId", installationId).param("userId", userId).param("now", now).update()
        insertSession(sessionId, userId, installationId, "desktop", null, tokenHash, now, expiresAt, null)
        jdbc.sql(
            """
            INSERT INTO attendance_preference(
                user_id, enabled, morning_enabled, evening_enabled, morning_start_hour,
                evening_end_hour, morning_interval_minutes, evening_interval_minutes,
                skip_sunday, skip_attendance_date, updated_at_epoch_ms
            ) VALUES (:userId, true, true, true, 9, 4, 15, 15, false, NULL, :now)
            """.trimIndent(),
        ).param("userId", userId).param("now", now).update()
        jdbc.sql(
            "INSERT INTO meal_preference(user_id, enabled, lunch, dinner, updated_at_epoch_ms) " +
                "VALUES (:userId, true, true, true, :now)",
        ).param("userId", userId).param("now", now).update()
    }

    fun rotateDesktop(
        principal: SessionPrincipal,
        newSessionId: UUID,
        tokenHash: String,
        now: Long,
        expiresAt: Long,
    ): Boolean {
        val revoked = jdbc.sql(
            """
            UPDATE app_session SET revoked_at_epoch_ms = :now
            WHERE id = :id AND user_id = :userId AND installation_id = :installationId
              AND kind = 'desktop' AND revoked_at_epoch_ms IS NULL
            """.trimIndent(),
        ).param("now", now).param("id", principal.sessionId).param("userId", principal.userId)
            .param("installationId", principal.installationId).update()
        if (revoked != 1) return false
        jdbc.sql("DELETE FROM desktop_ui_session WHERE parent_session_id = :id")
            .param("id", principal.sessionId).update()
        insertSession(
            newSessionId,
            principal.userId,
            principal.installationId,
            "desktop",
            null,
            tokenHash,
            now,
            expiresAt,
            null,
        )
        return true
    }

    fun replaceDesktopUiSession(
        id: UUID,
        principal: SessionPrincipal,
        tokenHash: String,
        origin: String,
        now: Long,
        expiresAt: Long,
    ) {
        jdbc.sql("DELETE FROM desktop_ui_session WHERE parent_session_id = :parent")
            .param("parent", principal.sessionId).update()
        jdbc.sql(
            """
            INSERT INTO desktop_ui_session(
                id, parent_session_id, user_id, installation_id, token_sha256,
                origin, scope, created_at_epoch_ms, expires_at_epoch_ms
            ) VALUES (:id, :parent, :userId, :installationId, :tokenHash,
                :origin, 'desktop-ui-v1', :now, :expiresAt)
            """.trimIndent(),
        ).param("id", id).param("parent", principal.sessionId).param("userId", principal.userId)
            .param("installationId", principal.installationId).param("tokenHash", tokenHash)
            .param("origin", origin).param("now", now).param("expiresAt", expiresAt).update()
    }

    fun deleteDesktopUiSession(principal: SessionPrincipal, origin: String): Int = jdbc.sql(
        """
        DELETE FROM desktop_ui_session
        WHERE parent_session_id = :parent AND user_id = :userId
          AND installation_id = :installationId AND origin = :origin
        """.trimIndent(),
    ).param("parent", principal.sessionId).param("userId", principal.userId)
        .param("installationId", principal.installationId).param("origin", origin).update()

    fun heartbeat(principal: SessionPrincipal, state: String, appVersion: String?, now: Long): Boolean = jdbc.sql(
        """
        UPDATE desktop_device
        SET last_seen_at_epoch_ms = :now, lms_session_state = :state,
            app_version = COALESCE(:appVersion, app_version)
        WHERE installation_id = :installationId AND user_id = :userId
        """.trimIndent(),
    ).param("now", now).param("state", state).param("appVersion", appVersion)
        .param("installationId", principal.installationId).param("userId", principal.userId).update() == 1

    fun putAttendance(principal: SessionPrincipal, request: AttendanceSnapshotRequest, now: Long) {
        val collectedAt = java.time.Instant.parse(request.collectedAt).toEpochMilli()
        jdbc.sql(
            """
            INSERT INTO attendance_snapshot(
                user_id, source_installation_id, attendance_date, cohort_id, cohort_status,
                cohort_start_date, cohort_end_date, morning_checked, evening_checked,
                collected_at_epoch_ms, received_at_epoch_ms
            ) VALUES (:userId, :installationId, :attendanceDate, :cohortId, :cohortStatus,
                :cohortStartDate, :cohortEndDate, :morningChecked, :eveningChecked,
                :collectedAt, :now)
            ON CONFLICT (user_id) DO UPDATE SET
                source_installation_id = EXCLUDED.source_installation_id,
                attendance_date = EXCLUDED.attendance_date,
                cohort_id = EXCLUDED.cohort_id,
                cohort_status = EXCLUDED.cohort_status,
                cohort_start_date = EXCLUDED.cohort_start_date,
                cohort_end_date = EXCLUDED.cohort_end_date,
                morning_checked = EXCLUDED.morning_checked,
                evening_checked = EXCLUDED.evening_checked,
                collected_at_epoch_ms = EXCLUDED.collected_at_epoch_ms,
                received_at_epoch_ms = EXCLUDED.received_at_epoch_ms
            WHERE attendance_snapshot.collected_at_epoch_ms <= EXCLUDED.collected_at_epoch_ms
            """.trimIndent(),
        ).param("userId", principal.userId).param("installationId", principal.installationId)
            .param("attendanceDate", Date.valueOf(request.attendanceDate)).param("cohortId", request.cohortId)
            .param("cohortStatus", request.cohortStatus)
            .param("cohortStartDate", request.cohortStartDate?.let(Date::valueOf))
            .param("cohortEndDate", request.cohortEndDate?.let(Date::valueOf))
            .param("morningChecked", request.morningChecked).param("eveningChecked", request.eveningChecked)
            .param("collectedAt", collectedAt).param("now", now).update()
    }

    fun attendance(userId: UUID): StoredAttendance? = jdbc.sql(
        "SELECT * FROM attendance_snapshot WHERE user_id = :userId",
    ).param("userId", userId).query { row, _ ->
        StoredAttendance(
            row.getDate("attendance_date").toLocalDate().toString(),
            row.getString("cohort_id"),
            row.getString("cohort_status"),
            row.getDate("cohort_start_date")?.toLocalDate()?.toString(),
            row.getDate("cohort_end_date")?.toLocalDate()?.toString(),
            row.getBoolean("morning_checked"),
            row.getBoolean("evening_checked"),
            row.getLong("collected_at_epoch_ms"),
        )
    }.optional().orElse(null)

    fun desktopDevices(userId: UUID): List<StoredDesktopDevice> = jdbc.sql(
        "SELECT * FROM desktop_device WHERE user_id = :userId ORDER BY installation_id",
    ).param("userId", userId).query { row, _ ->
        StoredDesktopDevice(
            row.getString("installation_id"),
            row.getObject("last_seen_at_epoch_ms", Long::class.javaObjectType),
            row.getString("lms_session_state"),
            row.getString("app_version"),
        )
    }.list()

    fun mobileSessions(userId: UUID): List<StoredMobileSession> = jdbc.sql(
        """
        SELECT session.*, EXISTS(
            SELECT 1 FROM push_subscription push
            WHERE push.session_id = session.id AND push.revoked_at_epoch_ms IS NULL
        ) AS push_enabled
        FROM app_session session
        WHERE session.user_id = :userId AND session.kind = 'mobile'
        ORDER BY session.created_at_epoch_ms DESC
        """.trimIndent(),
    ).param("userId", userId).query { row, _ ->
        StoredMobileSession(
            row.getObject("id", UUID::class.java),
            row.getString("label") ?: "모바일 기기",
            row.getString("installation_id"),
            row.getLong("created_at_epoch_ms"),
            row.getLong("expires_at_epoch_ms"),
            row.getLong("last_seen_at_epoch_ms"),
            row.getObject("revoked_at_epoch_ms", Long::class.javaObjectType),
            row.getBoolean("push_enabled"),
        )
    }.list()

    fun revokeMobile(userId: UUID, sessionId: UUID, now: Long): Boolean = jdbc.sql(
        """
        UPDATE app_session SET revoked_at_epoch_ms = :now
        WHERE id = :id AND user_id = :userId AND kind = 'mobile' AND revoked_at_epoch_ms IS NULL
        """.trimIndent(),
    ).param("now", now).param("id", sessionId).param("userId", userId).update() == 1

    fun insertMobileSession(
        id: UUID,
        userId: UUID,
        installationId: String,
        label: String,
        tokenHash: String,
        now: Long,
        expiresAt: Long,
        sourcePairingId: UUID,
    ) = insertSession(id, userId, installationId, "mobile", label, tokenHash, now, expiresAt, sourcePairingId)

    fun revokeCurrentMobile(sessionId: UUID, now: Long): Boolean = jdbc.sql(
        "UPDATE app_session SET revoked_at_epoch_ms = :now WHERE id = :id AND revoked_at_epoch_ms IS NULL",
    ).param("now", now).param("id", sessionId).update() == 1

    fun sessionExpiresAt(sessionId: UUID): Long? = jdbc.sql(
        "SELECT expires_at_epoch_ms FROM app_session WHERE id = :id AND revoked_at_epoch_ms IS NULL",
    ).param("id", sessionId).query(Long::class.java).optional().orElse(null)

    private fun insertSession(
        id: UUID,
        userId: UUID,
        installationId: String,
        kind: String,
        label: String?,
        tokenHash: String,
        now: Long,
        expiresAt: Long,
        sourcePairingId: UUID?,
    ) {
        jdbc.sql(
            """
            INSERT INTO app_session(
                id, user_id, installation_id, kind, label, token_sha256,
                created_at_epoch_ms, expires_at_epoch_ms, last_seen_at_epoch_ms,
                revoked_at_epoch_ms, source_pairing_id
            ) VALUES (:id, :userId, :installationId, :kind, :label, :tokenHash,
                :now, :expiresAt, :now, NULL, :sourcePairingId)
            """.trimIndent(),
        ).param("id", id).param("userId", userId).param("installationId", installationId)
            .param("kind", kind).param("label", label).param("tokenHash", tokenHash)
            .param("now", now).param("expiresAt", expiresAt).param("sourcePairingId", sourcePairingId).update()
    }
}

data class StoredAttendance(
    val attendanceDate: String,
    val cohortId: String?,
    val cohortStatus: String,
    val cohortStartDate: String?,
    val cohortEndDate: String?,
    val morningChecked: Boolean,
    val eveningChecked: Boolean,
    val collectedAtEpochMs: Long,
)

data class StoredDesktopDevice(
    val installationId: String,
    val lastSeenAtEpochMs: Long?,
    val lmsSessionState: String,
    val appVersion: String?,
)

data class StoredMobileSession(
    val id: UUID,
    val label: String,
    val installationId: String,
    val createdAtEpochMs: Long,
    val expiresAtEpochMs: Long,
    val lastSeenAtEpochMs: Long,
    val revokedAtEpochMs: Long?,
    val pushEnabled: Boolean,
)
