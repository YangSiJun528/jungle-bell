package app.junglebell.server.api.account

import app.junglebell.server.domain.account.*
import app.junglebell.server.api.security.CurrentSession
import app.junglebell.server.domain.security.SessionPrincipal
import app.junglebell.server.domain.security.requireDesktop
import jakarta.servlet.http.HttpServletRequest
import jakarta.validation.Valid
import org.springframework.http.HttpStatus
import org.slf4j.LoggerFactory
import org.springframework.web.bind.annotation.DeleteMapping
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.PutMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.ResponseStatus
import org.springframework.web.bind.annotation.RestController

@RestController
class AccountController(private val service: AccountService) {
    private val logger = LoggerFactory.getLogger(javaClass)

    @PostMapping("/api/desktop/installations")
    @ResponseStatus(HttpStatus.CREATED)
    fun enroll(
        @Valid @RequestBody request: DesktopInstallationRequest,
        servletRequest: HttpServletRequest,
    ): AccessTokenResponse {
        logger.info("Desktop enrollment request received.")
        val response = service.enroll(request, clientAddress(servletRequest))
        logger.info("Desktop enrollment request completed. status=201")
        return response
    }

    @PostMapping("/api/desktop/installations/rotate")
    fun rotate(
        @CurrentSession principal: SessionPrincipal,
        @RequestBody body: Map<String, Any?>,
    ): AccessTokenResponse {
        logger.info("Desktop session rotation request received.")
        require(body.isEmpty())
        val response = service.rotate(principal)
        logger.info("Desktop session rotation request completed. status=200")
        return response
    }

    @DeleteMapping("/api/desktop/installations/current")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun deleteDesktopIdentity(@CurrentSession principal: SessionPrincipal) {
        logger.info("Desktop identity deletion request received.")
        service.deleteDesktopIdentity(principal.requireDesktop())
        logger.info("Desktop identity deletion request completed. status=204")
    }

    @PostMapping("/api/desktop/webview-sessions")
    @ResponseStatus(HttpStatus.CREATED)
    fun issueDesktopUi(
        @CurrentSession principal: SessionPrincipal,
        @Valid @RequestBody request: DesktopUiSessionRequest,
    ): AccessTokenResponse {
        logger.info("Desktop UI session issue request received.")
        val response = service.issueDesktopUi(principal, request)
        logger.info("Desktop UI session issue request completed. status=201")
        return response
    }

    @DeleteMapping("/api/desktop/webview-sessions/current")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun revokeDesktopUi(
        @CurrentSession principal: SessionPrincipal,
        @Valid @RequestBody request: DesktopUiSessionRequest,
    ) {
        logger.info("Desktop UI session revocation request received.")
        service.revokeDesktopUi(principal, request)
        logger.info("Desktop UI session revocation request completed. status=204")
    }

    @PostMapping("/api/desktop/heartbeat")
    fun heartbeat(
        @CurrentSession principal: SessionPrincipal,
        @Valid @RequestBody request: DesktopHeartbeatRequest,
    ): HeartbeatResponse {
        logger.debug("Desktop heartbeat request received.")
        val response = service.heartbeat(principal, request)
        logger.debug("Desktop heartbeat request completed. status=200")
        return response
    }

    @GetMapping("/api/desktop/attendance")
    fun desktopAttendance(@CurrentSession principal: SessionPrincipal): AttendanceEnvelope {
        logger.debug("Desktop attendance request received.")
        val response = service.attendance(principal.userId)
        logger.debug("Desktop attendance request completed. status=200")
        return response
    }

    @PutMapping("/api/desktop/attendance")
    fun publishAttendance(
        @CurrentSession principal: SessionPrincipal,
        @Valid @RequestBody request: AttendanceSnapshotRequest,
    ): AttendanceEnvelope {
        logger.info("Attendance publication request received.")
        val response = service.publishAttendance(principal, request)
        logger.info("Attendance publication request completed. status=200")
        return response
    }

    @GetMapping("/api/me/attendance")
    fun attendance(@CurrentSession principal: SessionPrincipal): MobileAttendanceEnvelope {
        logger.debug("Mobile attendance request received.")
        val response = service.mobileAttendance(principal.userId)
        logger.debug("Mobile attendance request completed. status=200")
        return response
    }

    @GetMapping("/api/me/mobile-sessions")
    fun mobileSessions(@CurrentSession principal: SessionPrincipal): MobileSessionsEnvelope {
        logger.debug("Mobile session list request received.")
        val response = service.mobileSessions(principal.requireDesktop().userId)
        logger.debug("Mobile session list request completed. status=200")
        return response
    }

    @DeleteMapping("/api/me/mobile-sessions/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun revokeMobile(
        @CurrentSession principal: SessionPrincipal,
        @PathVariable id: String,
    ) {
        logger.info("Mobile session revocation request received.")
        service.revokeMobile(principal.requireDesktop().userId, id)
        logger.info("Mobile session revocation request completed. status=204")
    }

    @DeleteMapping("/api/me/session")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun disconnectMobile(@CurrentSession principal: SessionPrincipal) {
        logger.info("Mobile session disconnection request received.")
        service.disconnectMobile(principal)
        logger.info("Mobile session disconnection request completed. status=204")
    }

    @GetMapping("/api/me/session")
    fun mobileSession(@CurrentSession principal: SessionPrincipal): Map<String, Any> {
        logger.debug("Current mobile session request received.")
        val response = service.mobileSession(principal)
        logger.debug("Current mobile session request completed. status=200")
        return response
    }

    private fun clientAddress(request: HttpServletRequest): String =
        request.getHeader("CF-Connecting-IP")?.trim()?.takeIf { it.length in 1..64 }
            ?: request.remoteAddr.take(64)
}
