package app.junglebell.server.pairing

import app.junglebell.server.common.ApiException
import app.junglebell.server.security.SessionPrincipal
import app.junglebell.server.security.requireDesktop
import jakarta.servlet.http.Cookie
import jakarta.servlet.http.HttpServletRequest
import jakarta.servlet.http.HttpServletResponse
import jakarta.validation.Valid
import org.springframework.http.HttpHeaders
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseCookie
import org.springframework.security.core.annotation.AuthenticationPrincipal
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.ResponseStatus
import org.springframework.web.bind.annotation.RestController
import java.time.Duration

@RestController
class PairingController(private val service: PairingService) {
    @PostMapping("/api/me/pairings")
    @ResponseStatus(HttpStatus.CREATED)
    fun create(
        @AuthenticationPrincipal principal: SessionPrincipal,
        @RequestBody body: Map<String, Any?>,
    ): PairingCreated {
        require(body.isEmpty())
        return service.create(principal.requireDesktop())
    }

    @GetMapping("/api/me/pairings/{id}")
    fun status(@AuthenticationPrincipal principal: SessionPrincipal, @PathVariable id: String) =
        service.status(principal.requireDesktop(), id)

    @PostMapping("/api/me/pairings/{id}/approve")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun approve(
        @AuthenticationPrincipal principal: SessionPrincipal,
        @PathVariable id: String,
        @Valid @RequestBody body: PairingApprovalRequest,
    ) = service.approve(principal.requireDesktop(), id, body)

    @PostMapping("/api/pairings/{id}/claims")
    @ResponseStatus(HttpStatus.CREATED)
    fun claimQr(
        @PathVariable id: String,
        @Valid @RequestBody body: QrPairingClaimRequest,
        request: HttpServletRequest,
        response: HttpServletResponse,
    ): PairingClaimResponse {
        val claim = service.claimQr(id, body)
        setPendingCookie(request, response, claim)
        return PairingClaimResponse(claim.claimId)
    }

    @PostMapping("/api/pairings/claims")
    @ResponseStatus(HttpStatus.CREATED)
    fun claimManual(
        @Valid @RequestBody body: ManualPairingClaimRequest,
        request: HttpServletRequest,
        response: HttpServletResponse,
    ): PairingClaimResponse {
        val claim = service.claimManual(body)
        setPendingCookie(request, response, claim)
        return PairingClaimResponse(claim.claimId)
    }

    @PostMapping("/api/pairings/{id}/complete")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun complete(
        @PathVariable id: String,
        @RequestBody body: Map<String, Any?>,
        request: HttpServletRequest,
        response: HttpServletResponse,
    ) {
        require(body.isEmpty())
        val receipt = cookie(request, "__Host-jb_pending_claim") ?: cookie(request, "jb_pending_claim")
            ?: throw ApiException("PAIRING_RECEIPT_INVALID", HttpStatus.UNAUTHORIZED)
        val completed = service.complete(id, receipt)
        clearCookie(request, response, "jb_pending_claim")
        setCookie(
            request,
            response,
            "jb_device",
            completed.token,
            Duration.ofMillis((completed.expiresAtEpochMs - System.currentTimeMillis()).coerceAtLeast(0)),
        )
    }

    private fun setPendingCookie(request: HttpServletRequest, response: HttpServletResponse, claim: PairingClaim) =
        setCookie(
            request,
            response,
            "jb_pending_claim",
            claim.receipt,
            Duration.ofMillis((claim.expiresAtEpochMs - System.currentTimeMillis()).coerceAtLeast(0)),
        )

    private fun setCookie(
        request: HttpServletRequest,
        response: HttpServletResponse,
        name: String,
        value: String,
        maxAge: Duration,
    ) {
        val secure = request.isSecure || request.getHeader("X-Forwarded-Proto") == "https"
        val cookie = ResponseCookie.from(if (secure) "__Host-$name" else name, value)
            .httpOnly(true).secure(secure).sameSite("Strict").path("/").maxAge(maxAge).build()
        response.addHeader(HttpHeaders.SET_COOKIE, cookie.toString())
    }

    private fun clearCookie(request: HttpServletRequest, response: HttpServletResponse, name: String) =
        setCookie(request, response, name, "", Duration.ZERO)

    private fun cookie(request: HttpServletRequest, name: String): String? =
        request.cookies?.firstOrNull { it.name == name }?.value
}
