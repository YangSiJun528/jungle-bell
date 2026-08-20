package app.junglebell.server.api.pairing

import app.junglebell.server.common.error.ApiException
import app.junglebell.server.api.security.CurrentSession
import app.junglebell.server.domain.pairing.*
import app.junglebell.server.domain.security.SessionPrincipal
import app.junglebell.server.domain.security.requireDesktop
import app.junglebell.server.domain.usage.UsageFeature
import app.junglebell.server.domain.usage.UsageRecorder
import jakarta.servlet.http.Cookie
import jakarta.servlet.http.HttpServletRequest
import jakarta.servlet.http.HttpServletResponse
import jakarta.validation.Valid
import org.springframework.http.HttpHeaders
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseCookie
import org.slf4j.LoggerFactory
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.ResponseStatus
import org.springframework.web.bind.annotation.RestController
import java.time.Duration

@RestController
class PairingController(
    private val service: PairingService,
    private val usage: UsageRecorder,
) {
    private val logger = LoggerFactory.getLogger(javaClass)

    @PostMapping("/api/me/pairings")
    @ResponseStatus(HttpStatus.CREATED)
    fun create(
        @CurrentSession principal: SessionPrincipal,
        @RequestBody body: Map<String, Any?>,
    ): PairingCreated {
        logger.info("Pairing creation request received.")
        require(body.isEmpty())
        val response = service.create(principal.requireDesktop())
        logger.info("Pairing creation request completed. pairingId={} status=201", response.pairingId)
        return response
    }

    @GetMapping("/api/me/pairings/{id}")
    fun status(@CurrentSession principal: SessionPrincipal, @PathVariable id: String): PairingStatusResponse {
        logger.debug("Pairing status request received.")
        val response = service.status(principal.requireDesktop(), id)
        logger.debug("Pairing status request completed. status=200")
        return response
    }

    @PostMapping("/api/me/pairings/{id}/approve")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun approve(
        @CurrentSession principal: SessionPrincipal,
        @PathVariable id: String,
        @Valid @RequestBody body: PairingApprovalRequest,
    ) {
        logger.info("Pairing approval request received.")
        service.approve(principal.requireDesktop(), id, body)
        usage.recordFeature(principal, UsageFeature.MOBILE_DEVICE_PAIRED)
        logger.info("Pairing approval request completed. status=204")
    }

    @PostMapping("/api/pairings/{id}/claims")
    @ResponseStatus(HttpStatus.CREATED)
    fun claimQr(
        @PathVariable id: String,
        @Valid @RequestBody body: QrPairingClaimRequest,
        request: HttpServletRequest,
        response: HttpServletResponse,
    ): PairingClaimResponse {
        logger.info("QR pairing claim request received.")
        val claim = service.claimQr(id, body)
        setPendingCookie(request, response, claim)
        logger.info("QR pairing claim request completed. pairingId={} status=201", claim.claimId)
        return PairingClaimResponse(claim.claimId)
    }

    @PostMapping("/api/pairings/claims")
    @ResponseStatus(HttpStatus.CREATED)
    fun claimManual(
        @Valid @RequestBody body: ManualPairingClaimRequest,
        request: HttpServletRequest,
        response: HttpServletResponse,
    ): PairingClaimResponse {
        logger.info("Manual pairing claim request received.")
        val claim = service.claimManual(body)
        setPendingCookie(request, response, claim)
        logger.info("Manual pairing claim request completed. pairingId={} status=201", claim.claimId)
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
        logger.info("Pairing completion request received.")
        require(body.isEmpty())
        val receipt = cookie(request, "__Host-jb_pending_claim") ?: cookie(request, "jb_pending_claim")
        if (receipt == null) {
            logger.warn("Pairing completion rejected. reason=receipt_cookie_missing")
            throw ApiException("PAIRING_RECEIPT_INVALID", HttpStatus.UNAUTHORIZED)
        }
        val completed = service.complete(id, receipt)
        clearCookie(request, response, "jb_pending_claim")
        setCookie(
            request,
            response,
            "jb_device",
            completed.token,
            Duration.ofMillis((completed.expiresAtEpochMs - System.currentTimeMillis()).coerceAtLeast(0)),
        )
        logger.info("Pairing completion request completed. status=204")
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
