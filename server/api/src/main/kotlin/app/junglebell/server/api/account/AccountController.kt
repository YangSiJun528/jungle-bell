package app.junglebell.server.api.account

import app.junglebell.server.domain.account.*
import app.junglebell.server.api.security.CurrentSession
import app.junglebell.server.domain.security.SessionPrincipal
import app.junglebell.server.domain.security.requireDesktop
import jakarta.servlet.http.HttpServletRequest
import jakarta.validation.Valid
import org.springframework.http.HttpStatus
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
    @PostMapping("/api/desktop/installations")
    @ResponseStatus(HttpStatus.CREATED)
    fun enroll(
        @Valid @RequestBody request: DesktopInstallationRequest,
        servletRequest: HttpServletRequest,
    ) = service.enroll(request, clientAddress(servletRequest))

    @PostMapping("/api/desktop/installations/rotate")
    fun rotate(
        @CurrentSession principal: SessionPrincipal,
        @RequestBody body: Map<String, Any?>,
    ): AccessTokenResponse {
        require(body.isEmpty())
        return service.rotate(principal)
    }

    @DeleteMapping("/api/desktop/installations/current")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun deleteDesktopIdentity(@CurrentSession principal: SessionPrincipal) =
        service.deleteDesktopIdentity(principal.requireDesktop())

    @PostMapping("/api/desktop/webview-sessions")
    @ResponseStatus(HttpStatus.CREATED)
    fun issueDesktopUi(
        @CurrentSession principal: SessionPrincipal,
        @Valid @RequestBody request: DesktopUiSessionRequest,
    ) = service.issueDesktopUi(principal, request)

    @DeleteMapping("/api/desktop/webview-sessions/current")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun revokeDesktopUi(
        @CurrentSession principal: SessionPrincipal,
        @Valid @RequestBody request: DesktopUiSessionRequest,
    ) = service.revokeDesktopUi(principal, request)

    @PostMapping("/api/desktop/heartbeat")
    fun heartbeat(
        @CurrentSession principal: SessionPrincipal,
        @Valid @RequestBody request: DesktopHeartbeatRequest,
    ) = service.heartbeat(principal, request)

    @GetMapping("/api/desktop/attendance")
    fun desktopAttendance(@CurrentSession principal: SessionPrincipal) = service.attendance(principal.userId)

    @PutMapping("/api/desktop/attendance")
    fun publishAttendance(
        @CurrentSession principal: SessionPrincipal,
        @Valid @RequestBody request: AttendanceSnapshotRequest,
    ) = service.publishAttendance(principal, request)

    @GetMapping("/api/me/attendance")
    fun attendance(@CurrentSession principal: SessionPrincipal) = service.mobileAttendance(principal.userId)

    @GetMapping("/api/me/mobile-sessions")
    fun mobileSessions(@CurrentSession principal: SessionPrincipal) =
        service.mobileSessions(principal.requireDesktop().userId)

    @DeleteMapping("/api/me/mobile-sessions/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun revokeMobile(
        @CurrentSession principal: SessionPrincipal,
        @PathVariable id: String,
    ) = service.revokeMobile(principal.requireDesktop().userId, id)

    @DeleteMapping("/api/me/session")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun disconnectMobile(@CurrentSession principal: SessionPrincipal) = service.disconnectMobile(principal)

    @GetMapping("/api/me/session")
    fun mobileSession(@CurrentSession principal: SessionPrincipal) = service.mobileSession(principal)

    private fun clientAddress(request: HttpServletRequest): String =
        request.getHeader("CF-Connecting-IP")?.trim()?.takeIf { it.length in 1..64 }
            ?: request.remoteAddr.take(64)
}
