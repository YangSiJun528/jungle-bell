package app.junglebell.server.account

import app.junglebell.server.common.ApiException
import app.junglebell.server.config.JungleBellProperties
import app.junglebell.server.security.SessionPrincipal
import app.junglebell.server.security.TokenCodec
import org.springframework.http.HttpStatus
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import java.time.Clock
import java.time.Duration
import java.time.Instant
import java.util.UUID

@Service
class AccountService(
    private val repository: AccountRepository,
    private val tokens: TokenCodec,
    private val properties: JungleBellProperties,
    private val clock: Clock,
) {
    private val desktopTtl = Duration.ofDays(90)
    private val mobileTtl = Duration.ofDays(30)
    private val desktopUiTtl = Duration.ofMinutes(7)
    private val attendanceFreshness = Duration.ofMinutes(15)
    private val desktopOnlineWindow = Duration.ofMinutes(3)

    @Transactional
    fun enroll(request: DesktopInstallationRequest, clientAddress: String): AccessTokenResponse {
        val now = clock.millis()
        val allowed = listOf(
            tokens.plainHash("desktop-enrollment:ip:$clientAddress") to 240,
            tokens.plainHash("desktop-enrollment:installation:${request.installationId}") to 10,
        ).all { (key, limit) ->
            repository.consumeEnrollmentAttempt(key, now, ENROLLMENT_WINDOW.toMillis(), limit)
        }
        if (!allowed) throw ApiException("DESKTOP_ENROLLMENT_RATE_LIMITED", HttpStatus.TOO_MANY_REQUESTS)
        if (repository.desktopExists(request.installationId)) {
            throw ApiException("DESKTOP_ALREADY_ENROLLED", HttpStatus.CONFLICT)
        }
        val accessToken = tokens.opaque("jbd_")
        val expiresAt = now + desktopTtl.toMillis()
        repository.createDesktop(
            UUID.randomUUID(),
            request.installationId,
            UUID.randomUUID(),
            tokens.sessionHash(accessToken),
            now,
            expiresAt,
        )
        return AccessTokenResponse(accessToken, Instant.ofEpochMilli(expiresAt).toString())
    }

    @Transactional
    fun rotate(principal: SessionPrincipal): AccessTokenResponse {
        val now = clock.millis()
        val accessToken = tokens.opaque("jbd_")
        val expiresAt = now + desktopTtl.toMillis()
        if (!repository.rotateDesktop(
                principal,
                UUID.randomUUID(),
                tokens.sessionHash(accessToken),
                now,
                expiresAt,
            )
        ) throw ApiException("DESKTOP_SESSION_ROTATION_REJECTED", HttpStatus.CONFLICT)
        return AccessTokenResponse(accessToken, Instant.ofEpochMilli(expiresAt).toString())
    }

    @Transactional
    fun issueDesktopUi(principal: SessionPrincipal, request: DesktopUiSessionRequest): AccessTokenResponse {
        if (request.origin !in properties.allowedDesktopOrigins) {
            throw ApiException("ORIGIN_NOT_ALLOWED", HttpStatus.FORBIDDEN)
        }
        val now = clock.millis()
        val token = tokens.opaque("jbui_")
        val expiresAt = now + desktopUiTtl.toMillis()
        repository.replaceDesktopUiSession(
            UUID.randomUUID(),
            principal,
            tokens.uiSessionHash(token),
            request.origin,
            now,
            expiresAt,
        )
        return AccessTokenResponse(token, Instant.ofEpochMilli(expiresAt).toString())
    }

    @Transactional
    fun revokeDesktopUi(principal: SessionPrincipal, request: DesktopUiSessionRequest) {
        if (request.origin !in properties.allowedDesktopOrigins) {
            throw ApiException("ORIGIN_NOT_ALLOWED", HttpStatus.FORBIDDEN)
        }
        repository.deleteDesktopUiSession(principal, request.origin)
    }

    @Transactional
    fun heartbeat(principal: SessionPrincipal, request: DesktopHeartbeatRequest): HeartbeatResponse {
        val now = clock.millis()
        if (!repository.heartbeat(principal, request.lmsSessionState, request.appVersion, now)) {
            throw ApiException("DESKTOP_NOT_REGISTERED", HttpStatus.CONFLICT)
        }
        return HeartbeatResponse(Instant.ofEpochMilli(now).toString())
    }

    @Transactional
    fun publishAttendance(principal: SessionPrincipal, request: AttendanceSnapshotRequest): AttendanceEnvelope {
        request.validate()
        val now = clock.millis()
        val collectedAt = Instant.parse(request.collectedAt).toEpochMilli()
        if (collectedAt > now + Duration.ofMinutes(2).toMillis()) {
            throw ApiException("ATTENDANCE_COLLECTION_TIME_INVALID")
        }
        if (!repository.heartbeat(principal, "connected", null, now)) {
            throw ApiException("DESKTOP_NOT_REGISTERED", HttpStatus.CONFLICT)
        }
        repository.putAttendance(principal, request, now)
        return attendance(principal.userId)
    }

    @Transactional(readOnly = true)
    fun attendance(userId: UUID): AttendanceEnvelope {
        val stored = repository.attendance(userId) ?: return AttendanceEnvelope(null, "missing")
        val freshness = if (clock.millis() - stored.collectedAtEpochMs <= attendanceFreshness.toMillis()) {
            "fresh"
        } else {
            "stale"
        }
        return AttendanceEnvelope(stored.response(), freshness)
    }

    @Transactional(readOnly = true)
    fun mobileAttendance(userId: UUID): MobileAttendanceEnvelope {
        val attendance = attendance(userId)
        val now = clock.millis()
        val devices = repository.desktopDevices(userId).map { device ->
            DesktopDeviceResponse(
                id = device.installationId,
                deviceLabel = "PC 앱",
                lastSeenAt = device.lastSeenAtEpochMs?.let { Instant.ofEpochMilli(it).toString() },
                lmsSessionState = device.lmsSessionState,
                health = if (
                    device.lastSeenAtEpochMs != null &&
                    now - device.lastSeenAtEpochMs <= desktopOnlineWindow.toMillis()
                ) "online" else "offline",
                appVersion = device.appVersion,
            )
        }
        return MobileAttendanceEnvelope(attendance.attendance, attendance.freshness, devices)
    }

    @Transactional(readOnly = true)
    fun mobileSessions(userId: UUID): MobileSessionsEnvelope {
        val now = clock.millis()
        return MobileSessionsEnvelope(repository.mobileSessions(userId).map { session ->
            MobileSessionResponse(
                deviceId = "jbsi_${session.id}",
                deviceLabel = session.label,
                installationId = session.installationId,
                createdAt = Instant.ofEpochMilli(session.createdAtEpochMs).toString(),
                expiresAt = Instant.ofEpochMilli(session.expiresAtEpochMs).toString(),
                lastSeenAt = Instant.ofEpochMilli(session.lastSeenAtEpochMs).toString(),
                pushEnabled = session.pushEnabled,
                status = when {
                    session.revokedAtEpochMs != null -> "revoked"
                    session.expiresAtEpochMs <= now -> "expired"
                    else -> "active"
                },
            )
        })
    }

    @Transactional
    fun revokeMobile(userId: UUID, encodedSessionId: String) {
        val id = parseMobileSessionId(encodedSessionId)
        if (!repository.revokeMobile(userId, id, clock.millis())) {
            throw ApiException("DEVICE_NOT_FOUND", HttpStatus.NOT_FOUND)
        }
    }

    @Transactional
    fun disconnectMobile(principal: SessionPrincipal) {
        repository.revokeCurrentMobile(principal.sessionId, clock.millis())
    }

    @Transactional(readOnly = true)
    fun mobileSession(principal: SessionPrincipal): Map<String, Any> {
        val expiresAt = repository.sessionExpiresAt(principal.sessionId)
            ?: throw ApiException("AUTHENTICATION_REQUIRED", HttpStatus.UNAUTHORIZED)
        return mapOf(
            "authenticated" to true,
            "expiresAt" to Instant.ofEpochMilli(expiresAt).toString(),
        )
    }

    private fun parseMobileSessionId(value: String): UUID = try {
        UUID.fromString(value.removePrefix("jbsi_").takeIf { value.startsWith("jbsi_") } ?: "")
    } catch (_: IllegalArgumentException) {
        throw ApiException("INVALID_REQUEST")
    }

    private fun StoredAttendance.response() = AttendanceSnapshotResponse(
        attendanceDate,
        cohortId,
        cohortStatus,
        cohortStartDate,
        cohortEndDate,
        morningChecked,
        eveningChecked,
        Instant.ofEpochMilli(collectedAtEpochMs).toString(),
    )

    private companion object {
        val ENROLLMENT_WINDOW: Duration = Duration.ofMinutes(10)
    }
}
