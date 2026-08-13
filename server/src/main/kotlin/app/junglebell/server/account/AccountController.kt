package app.junglebell.server.account

import app.junglebell.server.security.SessionPrincipal
import jakarta.servlet.http.HttpServletRequest
import jakarta.validation.Valid
import org.springframework.http.HttpStatus
import org.springframework.security.core.annotation.AuthenticationPrincipal
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
        @AuthenticationPrincipal principal: SessionPrincipal,
        @RequestBody body: Map<String, Any?>,
    ): AccessTokenResponse {
        require(body.isEmpty())
        return service.rotate(principal)
    }

    @PostMapping("/api/desktop/webview-sessions")
    @ResponseStatus(HttpStatus.CREATED)
    fun issueDesktopUi(
        @AuthenticationPrincipal principal: SessionPrincipal,
        @Valid @RequestBody request: DesktopUiSessionRequest,
    ) = service.issueDesktopUi(principal, request)

    @DeleteMapping("/api/desktop/webview-sessions/current")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun revokeDesktopUi(
        @AuthenticationPrincipal principal: SessionPrincipal,
        @Valid @RequestBody request: DesktopUiSessionRequest,
    ) = service.revokeDesktopUi(principal, request)

    @PostMapping("/api/desktop/heartbeat")
    fun heartbeat(
        @AuthenticationPrincipal principal: SessionPrincipal,
        @Valid @RequestBody request: DesktopHeartbeatRequest,
    ) = service.heartbeat(principal, request)

    @GetMapping("/api/desktop/attendance", "/api/desktop-ui/attendance")
    fun desktopAttendance(@AuthenticationPrincipal principal: SessionPrincipal) = service.attendance(principal.userId)

    @PutMapping("/api/desktop/attendance")
    fun publishAttendance(
        @AuthenticationPrincipal principal: SessionPrincipal,
        @Valid @RequestBody request: AttendanceSnapshotRequest,
    ) = service.publishAttendance(principal, request)

    @GetMapping("/api/mobile/attendance")
    fun mobileAttendance(@AuthenticationPrincipal principal: SessionPrincipal) = service.mobileAttendance(principal.userId)

    @GetMapping("/api/desktop/mobile-sessions", "/api/desktop-ui/mobile-sessions")
    fun mobileSessions(@AuthenticationPrincipal principal: SessionPrincipal) = service.mobileSessions(principal.userId)

    @DeleteMapping(
        "/api/desktop/mobile-sessions/{id}",
        "/api/desktop-ui/mobile-sessions/{id}",
    )
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun revokeMobile(
        @AuthenticationPrincipal principal: SessionPrincipal,
        @PathVariable id: String,
    ) = service.revokeMobile(principal.userId, id)

    @DeleteMapping("/api/mobile/session")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun disconnectMobile(@AuthenticationPrincipal principal: SessionPrincipal) = service.disconnectMobile(principal)

    @GetMapping("/api/mobile/session")
    fun mobileSession(@AuthenticationPrincipal principal: SessionPrincipal) = service.mobileSession(principal)

    private fun clientAddress(request: HttpServletRequest): String =
        request.getHeader("CF-Connecting-IP")?.trim()?.takeIf { it.length in 1..64 }
            ?: request.remoteAddr.take(64)
}
