package app.junglebell.server.domain.account

import app.junglebell.server.domain.security.SessionPrincipal
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.stereotype.Repository
import org.springframework.transaction.annotation.Transactional
import java.sql.Date
import java.util.UUID

@Repository
class JdbcAccountStore(private val jdbc: JdbcClient) : AccountStore {
    @Transactional
    override fun enrollDesktop(
        rateLimits: List<EnrollmentRateLimit>,
        rateWindowMs: Long,
        userId: UUID,
        installationId: String,
        sessionId: UUID,
        tokenHash: String,
        now: Long,
        expiresAt: Long,
    ) {
        val allowed = rateLimits.all { rateLimit ->
            consumeEnrollmentAttempt(rateLimit.key, now, rateWindowMs, rateLimit.limit)
        }
        if (!allowed) {
            throw DesktopEnrollmentRateLimitedException()
        }
        if (desktopExists(installationId)) {
            throw DesktopAlreadyEnrolledException()
        }
        createDesktop(userId, installationId, sessionId, tokenHash, now, expiresAt)
    }

    private fun consumeEnrollmentAttempt(
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

    private fun desktopExists(installationId: String): Boolean = jdbc.sql(
        "SELECT EXISTS(SELECT 1 FROM desktop_device WHERE installation_id = :installationId)",
    ).param("installationId", installationId).query(Boolean::class.java).single()

    private fun createDesktop(
        userId: UUID,
        installationId: String,
        sessionId: UUID,
        tokenHash: String,
        now: Long,
        expiresAt: Long,
    ) {
        jdbc.sql("INSERT INTO app_user(id, created_at_epoch_ms) VALUES (:id, :now) RETURNING id")
            .param("id", userId).param("now", now).query(UUID::class.java).single()
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

    override fun rotateDesktop(
        principal: SessionPrincipal,
        newSessionId: UUID,
        tokenHash: String,
        now: Long,
        expiresAt: Long,
    ): Boolean = jdbc.sql(
        """
        WITH revoked AS (
            UPDATE app_session
            SET revoked_at_epoch_ms = :now
            WHERE id = :currentSessionId AND user_id = :userId
              AND installation_id = :installationId
              AND kind = 'desktop' AND revoked_at_epoch_ms IS NULL
            RETURNING user_id, installation_id
        ), removed_ui AS (
            DELETE FROM desktop_ui_session ui
            USING revoked
            WHERE ui.parent_session_id = :currentSessionId
            RETURNING ui.id
        ), created AS (
            INSERT INTO app_session(
                id, user_id, installation_id, kind, label, token_sha256,
                created_at_epoch_ms, expires_at_epoch_ms, last_seen_at_epoch_ms,
                revoked_at_epoch_ms, source_pairing_id
            )
            SELECT :newSessionId, user_id, installation_id, 'desktop', NULL, :tokenHash,
                :now, :expiresAt, :now, NULL, NULL
            FROM revoked
            RETURNING id
        )
        SELECT id FROM created
        """.trimIndent(),
    ).param("now", now).param("currentSessionId", principal.sessionId)
        .param("userId", principal.userId).param("installationId", principal.installationId)
        .param("newSessionId", newSessionId).param("tokenHash", tokenHash).param("expiresAt", expiresAt)
        .query(UUID::class.java).optional().isPresent

    override fun replaceDesktopUiSession(
        id: UUID,
        principal: SessionPrincipal,
        tokenHash: String,
        origin: String,
        now: Long,
        expiresAt: Long,
    ) {
        jdbc.sql(
            """
            INSERT INTO desktop_ui_session(
                id, parent_session_id, user_id, installation_id, token_sha256,
                origin, scope, created_at_epoch_ms, expires_at_epoch_ms
            ) VALUES (:id, :parent, :userId, :installationId, :tokenHash,
                :origin, 'desktop-ui-v1', :now, :expiresAt)
            ON CONFLICT (parent_session_id) DO UPDATE SET
                id = EXCLUDED.id,
                user_id = EXCLUDED.user_id,
                installation_id = EXCLUDED.installation_id,
                token_sha256 = EXCLUDED.token_sha256,
                origin = EXCLUDED.origin,
                scope = EXCLUDED.scope,
                created_at_epoch_ms = EXCLUDED.created_at_epoch_ms,
                expires_at_epoch_ms = EXCLUDED.expires_at_epoch_ms
            RETURNING id
            """.trimIndent(),
        ).param("id", id).param("parent", principal.sessionId).param("userId", principal.userId)
            .param("installationId", principal.installationId).param("tokenHash", tokenHash)
            .param("origin", origin).param("now", now).param("expiresAt", expiresAt)
            .query(UUID::class.java).single()
    }

    override fun deleteDesktopUiSession(principal: SessionPrincipal, origin: String): Boolean = jdbc.sql(
        """
        DELETE FROM desktop_ui_session
        WHERE parent_session_id = :parent AND user_id = :userId
          AND installation_id = :installationId AND origin = :origin
        RETURNING id
        """.trimIndent(),
    ).param("parent", principal.sessionId).param("userId", principal.userId)
        .param("installationId", principal.installationId).param("origin", origin)
        .query(UUID::class.java).optional().isPresent

    override fun heartbeat(principal: SessionPrincipal, state: String, appVersion: String?, now: Long): Boolean = jdbc.sql(
        """
        UPDATE desktop_device
        SET last_seen_at_epoch_ms = :now, lms_session_state = :state,
            app_version = COALESCE(:appVersion, app_version)
        WHERE installation_id = :installationId AND user_id = :userId
        RETURNING installation_id
        """.trimIndent(),
    ).param("now", now).param("state", state).param("appVersion", appVersion)
        .param("installationId", principal.installationId).param("userId", principal.userId)
        .query(String::class.java).optional().isPresent

    @Transactional
    override fun recordAttendance(principal: SessionPrincipal, request: AttendanceSnapshotRequest, now: Long): Boolean {
        if (!heartbeat(principal, "connected", null, now)) return false
        putAttendance(principal, request, now)
        return true
    }

    private fun putAttendance(principal: SessionPrincipal, request: AttendanceSnapshotRequest, now: Long): Boolean {
        val collectedAt = java.time.Instant.parse(request.collectedAt).toEpochMilli()
        return jdbc.sql(
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
            RETURNING user_id
            """.trimIndent(),
        ).param("userId", principal.userId).param("installationId", principal.installationId)
            .param("attendanceDate", Date.valueOf(request.attendanceDate)).param("cohortId", request.cohortId)
            .param("cohortStatus", request.cohortStatus)
            .param("cohortStartDate", request.cohortStartDate?.let(Date::valueOf))
            .param("cohortEndDate", request.cohortEndDate?.let(Date::valueOf))
            .param("morningChecked", request.morningChecked).param("eveningChecked", request.eveningChecked)
            .param("collectedAt", collectedAt).param("now", now)
            .query(UUID::class.java).optional().isPresent
    }

    override fun attendance(userId: UUID): StoredAttendance? = jdbc.sql(
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

    override fun desktopDevices(userId: UUID): List<StoredDesktopDevice> = jdbc.sql(
        "SELECT * FROM desktop_device WHERE user_id = :userId ORDER BY installation_id",
    ).param("userId", userId).query { row, _ ->
        StoredDesktopDevice(
            row.getString("installation_id"),
            row.getObject("last_seen_at_epoch_ms", Long::class.javaObjectType),
            row.getString("lms_session_state"),
            row.getString("app_version"),
        )
    }.list()

    override fun mobileSessions(userId: UUID): List<StoredMobileSession> = jdbc.sql(
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

    override fun revokeMobile(userId: UUID, sessionId: UUID, now: Long): Boolean = jdbc.sql(
        """
        UPDATE app_session SET revoked_at_epoch_ms = :now
        WHERE id = :id AND user_id = :userId AND kind = 'mobile' AND revoked_at_epoch_ms IS NULL
        RETURNING id
        """.trimIndent(),
    ).param("now", now).param("id", sessionId).param("userId", userId)
        .query(UUID::class.java).optional().isPresent

    override fun revokeCurrentMobile(sessionId: UUID, now: Long): Boolean = jdbc.sql(
        """
        UPDATE app_session SET revoked_at_epoch_ms = :now
        WHERE id = :id AND revoked_at_epoch_ms IS NULL
        RETURNING id
        """.trimIndent(),
    ).param("now", now).param("id", sessionId).query(UUID::class.java).optional().isPresent

    override fun sessionExpiresAt(sessionId: UUID): Long? = jdbc.sql(
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
