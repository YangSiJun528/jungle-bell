package app.junglebell.server.domain.account

import app.junglebell.server.common.error.ApiException
import app.junglebell.server.common.config.JungleBellProperties
import app.junglebell.server.domain.security.SessionPrincipal
import app.junglebell.server.domain.security.TokenCodec
import org.springframework.http.HttpStatus
import org.springframework.stereotype.Service
import java.time.Clock
import java.time.Duration
import java.time.Instant
import java.util.UUID

@Service
class AccountService(
    private val store: AccountStore,
    private val tokens: TokenCodec,
    private val properties: JungleBellProperties,
    private val clock: Clock,
) {
    private val desktopTtl = Duration.ofDays(90)
    private val mobileTtl = Duration.ofDays(30)
    private val desktopUiTtl = Duration.ofMinutes(7)
    private val attendanceFreshness = Duration.ofMinutes(15)
    private val desktopOnlineWindow = Duration.ofMinutes(3)

    fun enroll(request: DesktopInstallationRequest, clientAddress: String): AccessTokenResponse {
        val now = clock.millis()
        val accessToken = tokens.opaque("jbd_")
        val expiresAt = now + desktopTtl.toMillis()
        try {
            store.enrollDesktop(
                listOf(
                    EnrollmentRateLimit(tokens.plainHash("desktop-enrollment:ip:$clientAddress"), 240),
                    EnrollmentRateLimit(
                        tokens.plainHash("desktop-enrollment:installation:${request.installationId}"),
                        10,
                    ),
                ),
                ENROLLMENT_WINDOW.toMillis(), UUID.randomUUID(), request.installationId, UUID.randomUUID(),
                tokens.sessionHash(accessToken), now, expiresAt,
            )
        } catch (_: DesktopEnrollmentRateLimitedException) {
            throw ApiException("DESKTOP_ENROLLMENT_RATE_LIMITED", HttpStatus.TOO_MANY_REQUESTS)
        } catch (_: DesktopAlreadyEnrolledException) {
            throw ApiException("DESKTOP_ALREADY_ENROLLED", HttpStatus.CONFLICT)
        }
        return AccessTokenResponse(accessToken, Instant.ofEpochMilli(expiresAt).toString())
    }

    fun rotate(principal: SessionPrincipal): AccessTokenResponse {
        val now = clock.millis()
        val accessToken = tokens.opaque("jbd_")
        val expiresAt = now + desktopTtl.toMillis()
        if (!store.rotateDesktop(
                principal,
                UUID.randomUUID(),
                tokens.sessionHash(accessToken),
                now,
                expiresAt,
            )
        ) throw ApiException("DESKTOP_SESSION_ROTATION_REJECTED", HttpStatus.CONFLICT)
        return AccessTokenResponse(accessToken, Instant.ofEpochMilli(expiresAt).toString())
    }

    fun deleteDesktopIdentity(principal: SessionPrincipal) {
        if (!store.deleteDesktopIdentity(principal)) {
            throw ApiException("DESKTOP_IDENTITY_DELETION_REJECTED", HttpStatus.CONFLICT)
        }
    }

    fun issueDesktopUi(principal: SessionPrincipal, request: DesktopUiSessionRequest): AccessTokenResponse {
        if (request.origin !in properties.allowedDesktopOrigins) {
            throw ApiException("ORIGIN_NOT_ALLOWED", HttpStatus.FORBIDDEN)
        }
        val now = clock.millis()
        val token = tokens.opaque("jbui_")
        val expiresAt = now + desktopUiTtl.toMillis()
        store.replaceDesktopUiSession(
            UUID.randomUUID(),
            principal,
            tokens.uiSessionHash(token),
            request.origin,
            now,
            expiresAt,
        )
        return AccessTokenResponse(token, Instant.ofEpochMilli(expiresAt).toString())
    }

    fun revokeDesktopUi(principal: SessionPrincipal, request: DesktopUiSessionRequest) {
        if (request.origin !in properties.allowedDesktopOrigins) {
            throw ApiException("ORIGIN_NOT_ALLOWED", HttpStatus.FORBIDDEN)
        }
        store.deleteDesktopUiSession(principal, request.origin)
    }

    fun heartbeat(principal: SessionPrincipal, request: DesktopHeartbeatRequest): HeartbeatResponse {
        val now = clock.millis()
        if (!store.heartbeat(principal, request.lmsSessionState, request.appVersion, now)) {
            throw ApiException("DESKTOP_NOT_REGISTERED", HttpStatus.CONFLICT)
        }
        return HeartbeatResponse(Instant.ofEpochMilli(now).toString())
    }

    fun publishAttendance(principal: SessionPrincipal, request: AttendanceSnapshotRequest): AttendanceEnvelope {
        request.validate()
        val now = clock.millis()
        val collectedAt = Instant.parse(request.collectedAt).toEpochMilli()
        if (collectedAt > now + Duration.ofMinutes(2).toMillis()) {
            throw ApiException("ATTENDANCE_COLLECTION_TIME_INVALID")
        }
        if (!store.recordAttendance(principal, request, now)) {
            throw ApiException("DESKTOP_NOT_REGISTERED", HttpStatus.CONFLICT)
        }
        return attendance(principal.userId)
    }

    fun attendance(userId: UUID): AttendanceEnvelope {
        val stored = store.attendance(userId) ?: return AttendanceEnvelope(null, "missing")
        val freshness = if (clock.millis() - stored.collectedAtEpochMs <= attendanceFreshness.toMillis()) {
            "fresh"
        } else {
            "stale"
        }
        return AttendanceEnvelope(stored.response(), freshness)
    }

    fun mobileAttendance(userId: UUID): MobileAttendanceEnvelope {
        val attendance = attendance(userId)
        val now = clock.millis()
        val devices = store.desktopDevices(userId).map { device ->
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

    fun mobileSessions(userId: UUID): MobileSessionsEnvelope {
        val now = clock.millis()
        return MobileSessionsEnvelope(store.mobileSessions(userId).map { session ->
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

    fun revokeMobile(userId: UUID, encodedSessionId: String) {
        val id = parseMobileSessionId(encodedSessionId)
        if (!store.revokeMobile(userId, id, clock.millis())) {
            throw ApiException("DEVICE_NOT_FOUND", HttpStatus.NOT_FOUND)
        }
    }

    fun disconnectMobile(principal: SessionPrincipal) {
        store.revokeCurrentMobile(principal.sessionId, clock.millis())
    }

    fun mobileSession(principal: SessionPrincipal): Map<String, Any> {
        val expiresAt = store.sessionExpiresAt(principal.sessionId)
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
