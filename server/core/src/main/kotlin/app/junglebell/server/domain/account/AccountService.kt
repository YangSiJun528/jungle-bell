package app.junglebell.server.domain.account

import app.junglebell.server.common.error.ApiException
import app.junglebell.server.common.config.JungleBellProperties
import app.junglebell.server.domain.security.SessionPrincipal
import app.junglebell.server.domain.security.TokenCodec
import org.springframework.http.HttpStatus
import org.slf4j.LoggerFactory
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
    private val logger = LoggerFactory.getLogger(javaClass)
    private val desktopTtl = Duration.ofDays(90)
    private val mobileTtl = Duration.ofDays(30)
    private val desktopUiTtl = Duration.ofMinutes(7)
    private val attendanceFreshness = Duration.ofMinutes(15)
    private val desktopOnlineWindow = Duration.ofMinutes(3)

    fun enroll(request: DesktopInstallationRequest, clientAddress: String): AccessTokenResponse {
        logger.info("Desktop enrollment started.")
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
                ENROLLMENT_WINDOW.toMillis(), UUID.randomUUID(), request.installationId,
                request.usageAnalyticsEnabled, UUID.randomUUID(), tokens.sessionHash(accessToken), now, expiresAt,
            )
        } catch (_: DesktopEnrollmentRateLimitedException) {
            logger.warn("Desktop enrollment rejected. reason=rate_limited")
            throw ApiException("DESKTOP_ENROLLMENT_RATE_LIMITED", HttpStatus.TOO_MANY_REQUESTS)
        } catch (_: DesktopAlreadyEnrolledException) {
            logger.warn("Desktop enrollment rejected. reason=already_enrolled")
            throw ApiException("DESKTOP_ALREADY_ENROLLED", HttpStatus.CONFLICT)
        }
        val response = AccessTokenResponse(accessToken, Instant.ofEpochMilli(expiresAt).toString())
        logger.info("Desktop enrollment completed. result=enrolled")
        return response
    }

    fun rotate(principal: SessionPrincipal): AccessTokenResponse {
        logger.info("Desktop session rotation started.")
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
        ) {
            logger.warn("Desktop session rotation rejected. reason=session_not_active")
            throw ApiException("DESKTOP_SESSION_ROTATION_REJECTED", HttpStatus.CONFLICT)
        }
        val response = AccessTokenResponse(accessToken, Instant.ofEpochMilli(expiresAt).toString())
        logger.info("Desktop session rotation completed. result=rotated")
        return response
    }

    fun deleteDesktopIdentity(principal: SessionPrincipal) {
        logger.info("Desktop identity deletion started.")
        if (!store.deleteDesktopIdentity(principal)) {
            logger.warn("Desktop identity deletion rejected. reason=identity_not_active")
            throw ApiException("DESKTOP_IDENTITY_DELETION_REJECTED", HttpStatus.CONFLICT)
        }
        logger.info("Desktop identity deletion completed. result=deleted")
    }

    fun issueDesktopUi(principal: SessionPrincipal, request: DesktopUiSessionRequest): AccessTokenResponse {
        logger.info("Desktop UI session issue started.")
        if (request.origin !in properties.allowedDesktopOrigins) {
            logger.warn("Desktop UI session issue rejected. reason=origin_not_allowed")
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
        val response = AccessTokenResponse(token, Instant.ofEpochMilli(expiresAt).toString())
        logger.info("Desktop UI session issue completed. result=issued")
        return response
    }

    fun revokeDesktopUi(principal: SessionPrincipal, request: DesktopUiSessionRequest) {
        logger.info("Desktop UI session revocation started.")
        if (request.origin !in properties.allowedDesktopOrigins) {
            logger.warn("Desktop UI session revocation rejected. reason=origin_not_allowed")
            throw ApiException("ORIGIN_NOT_ALLOWED", HttpStatus.FORBIDDEN)
        }
        val revoked = store.deleteDesktopUiSession(principal, request.origin)
        logger.info("Desktop UI session revocation completed. revoked={}", revoked)
    }

    fun heartbeat(principal: SessionPrincipal, request: DesktopHeartbeatRequest): HeartbeatResponse {
        logger.debug("Desktop heartbeat started.")
        val now = clock.millis()
        if (!store.heartbeat(principal, request.lmsSessionState, request.appVersion, now)) {
            logger.warn("Desktop heartbeat rejected. reason=desktop_not_registered")
            throw ApiException("DESKTOP_NOT_REGISTERED", HttpStatus.CONFLICT)
        }
        val response = HeartbeatResponse(Instant.ofEpochMilli(now).toString())
        logger.debug("Desktop heartbeat completed. result=recorded")
        return response
    }

    fun publishAttendance(principal: SessionPrincipal, request: AttendanceSnapshotRequest): AttendanceEnvelope {
        logger.info("Attendance publication started.")
        request.validate()
        val now = clock.millis()
        val collectedAt = Instant.parse(request.collectedAt).toEpochMilli()
        if (collectedAt > now + Duration.ofMinutes(2).toMillis()) {
            logger.warn("Attendance publication rejected. reason=collection_time_in_future")
            throw ApiException("ATTENDANCE_COLLECTION_TIME_INVALID")
        }
        if (!store.recordAttendance(principal, request, now)) {
            logger.warn("Attendance publication rejected. reason=desktop_not_registered")
            throw ApiException("DESKTOP_NOT_REGISTERED", HttpStatus.CONFLICT)
        }
        val response = attendance(principal.userId)
        logger.info("Attendance publication completed. freshness={}", response.freshness)
        return response
    }

    fun attendance(userId: UUID): AttendanceEnvelope {
        logger.debug("Attendance lookup started.")
        val stored = store.attendance(userId)
        if (stored == null) {
            logger.debug("Attendance lookup completed. result=missing")
            return AttendanceEnvelope(null, "missing")
        }
        val freshness = if (clock.millis() - stored.collectedAtEpochMs <= attendanceFreshness.toMillis()) {
            "fresh"
        } else {
            "stale"
        }
        val response = AttendanceEnvelope(stored.response(), freshness)
        logger.debug("Attendance lookup completed. freshness={}", freshness)
        return response
    }

    fun mobileAttendance(userId: UUID): MobileAttendanceEnvelope {
        logger.debug("Mobile attendance lookup started.")
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
        val response = MobileAttendanceEnvelope(attendance.attendance, attendance.freshness, devices)
        logger.debug(
            "Mobile attendance lookup completed. freshness={} desktopCount={}",
            attendance.freshness,
            devices.size,
        )
        return response
    }

    fun mobileSessions(userId: UUID): MobileSessionsEnvelope {
        logger.debug("Mobile session lookup started.")
        val now = clock.millis()
        val response = MobileSessionsEnvelope(store.mobileSessions(userId).map { session ->
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
        logger.debug("Mobile session lookup completed. sessionCount={}", response.devices.size)
        return response
    }

    fun revokeMobile(userId: UUID, encodedSessionId: String) {
        logger.info("Mobile session revocation started.")
        val id = parseMobileSessionId(encodedSessionId)
        if (!store.revokeMobile(userId, id, clock.millis())) {
            logger.warn("Mobile session revocation rejected. reason=device_not_found")
            throw ApiException("DEVICE_NOT_FOUND", HttpStatus.NOT_FOUND)
        }
        logger.info("Mobile session revocation completed. result=revoked")
    }

    fun disconnectMobile(principal: SessionPrincipal) {
        logger.info("Current mobile session disconnection started.")
        val revoked = store.revokeCurrentMobile(principal.sessionId, clock.millis())
        logger.info("Current mobile session disconnection completed. revoked={}", revoked)
    }

    fun mobileSession(principal: SessionPrincipal): Map<String, Any> {
        logger.debug("Current mobile session lookup started.")
        val expiresAt = store.sessionExpiresAt(principal.sessionId)
        if (expiresAt == null) {
            logger.warn("Current mobile session lookup rejected. reason=session_not_found")
            throw ApiException("AUTHENTICATION_REQUIRED", HttpStatus.UNAUTHORIZED)
        }
        val response = mapOf(
            "authenticated" to true,
            "expiresAt" to Instant.ofEpochMilli(expiresAt).toString(),
        )
        logger.debug("Current mobile session lookup completed. result=authenticated")
        return response
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
