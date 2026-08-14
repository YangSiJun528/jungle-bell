package app.junglebell.server.domain.account

import app.junglebell.server.domain.security.SessionPrincipal
import java.util.UUID

/**
 * 계정과 기기 수명주기에 필요한 영속 작업 단위입니다.
 *
 * 구현체는 각 메서드가 표현하는 작업을 원자적으로 완료해야 합니다.
 */
interface AccountStore {
    fun enrollDesktop(
        rateLimits: List<EnrollmentRateLimit>,
        rateWindowMs: Long,
        userId: UUID,
        installationId: String,
        sessionId: UUID,
        tokenHash: String,
        now: Long,
        expiresAt: Long,
    )

    fun rotateDesktop(
        principal: SessionPrincipal,
        newSessionId: UUID,
        tokenHash: String,
        now: Long,
        expiresAt: Long,
    ): Boolean

    fun replaceDesktopUiSession(
        id: UUID,
        principal: SessionPrincipal,
        tokenHash: String,
        origin: String,
        now: Long,
        expiresAt: Long,
    )

    fun deleteDesktopUiSession(principal: SessionPrincipal, origin: String): Boolean
    fun heartbeat(principal: SessionPrincipal, state: String, appVersion: String?, now: Long): Boolean
    fun recordAttendance(principal: SessionPrincipal, request: AttendanceSnapshotRequest, now: Long): Boolean
    fun attendance(userId: UUID): StoredAttendance?
    fun desktopDevices(userId: UUID): List<StoredDesktopDevice>
    fun mobileSessions(userId: UUID): List<StoredMobileSession>
    fun revokeMobile(userId: UUID, sessionId: UUID, now: Long): Boolean
    fun revokeCurrentMobile(sessionId: UUID, now: Long): Boolean
    fun sessionExpiresAt(sessionId: UUID): Long?
}

data class EnrollmentRateLimit(val key: String, val limit: Int)

class DesktopEnrollmentRateLimitedException : RuntimeException("desktop_enrollment_rate_limited")

class DesktopAlreadyEnrolledException : RuntimeException("desktop_already_enrolled")

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
