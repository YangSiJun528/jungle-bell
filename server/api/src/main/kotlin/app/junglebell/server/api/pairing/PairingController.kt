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
import org.springframework.http.ResponseEntity
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

    @PostMapping("/api/pairings/{id}/handoff")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun prepareHandoff(
        @PathVariable id: String,
        @Valid @RequestBody body: QrPairingHandoffRequest,
        request: HttpServletRequest,
        response: HttpServletResponse,
    ) {
        logger.info("Pairing install handoff request received.")
        val expiresAtEpochMs = service.prepareHandoff(id, body.challenge)
        clearCookie(request, response, PENDING_CLAIM_COOKIE)
        setCookie(
            request,
            response,
            PAIRING_HANDOFF_COOKIE,
            body.challenge,
            Duration.ofMillis((expiresAtEpochMs - System.currentTimeMillis()).coerceAtLeast(0)),
        )
        logger.info("Pairing install handoff request completed. pairingId={} status=204", id)
    }

    @PostMapping("/api/pairings/handoffs/claims")
    fun claimHandoff(
        @Valid @RequestBody body: PairingHandoffClaimRequest,
        request: HttpServletRequest,
        response: HttpServletResponse,
    ): ResponseEntity<PairingClaimResponse> {
        logger.info("Pairing install handoff claim request received.")
        val challenge = cookie(request, secureCookieName(request, PAIRING_HANDOFF_COOKIE))
            ?: cookie(request, PAIRING_HANDOFF_COOKIE)
            ?: return ResponseEntity.noContent().build()
        return try {
            val claim = service.claimHandoff(challenge, body)
            clearCookie(request, response, PAIRING_HANDOFF_COOKIE)
            setPendingCookie(request, response, claim)
            logger.info(
                "Pairing install handoff claim request completed. pairingId={} status=201",
                claim.claimId,
            )
            ResponseEntity.status(HttpStatus.CREATED).body(PairingClaimResponse(claim.claimId))
        } catch (error: ApiException) {
            clearCookie(request, response, PAIRING_HANDOFF_COOKIE)
            throw error
        }
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
        val receipt = cookie(request, secureCookieName(request, PENDING_CLAIM_COOKIE))
            ?: cookie(request, PENDING_CLAIM_COOKIE)
        if (receipt == null) {
            logger.warn("Pairing completion rejected. reason=receipt_cookie_missing")
            throw ApiException("PAIRING_RECEIPT_INVALID", HttpStatus.UNAUTHORIZED)
        }
        val completed = service.complete(id, receipt)
        clearCookie(request, response, PENDING_CLAIM_COOKIE)
        setCookie(
            request,
            response,
            DEVICE_COOKIE,
            completed.token,
            Duration.ofMillis((completed.expiresAtEpochMs - System.currentTimeMillis()).coerceAtLeast(0)),
        )
        logger.info("Pairing completion request completed. status=204")
    }

    private fun setPendingCookie(request: HttpServletRequest, response: HttpServletResponse, claim: PairingClaim) =
        setCookie(
            request,
            response,
            PENDING_CLAIM_COOKIE,
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
        val secure = secureRequest(request)
        val cookie = ResponseCookie.from(if (secure) secureCookieName(request, name) else name, value)
            .httpOnly(true).secure(secure).sameSite("Strict").path("/").maxAge(maxAge).build()
        response.addHeader(HttpHeaders.SET_COOKIE, cookie.toString())
    }

    private fun clearCookie(request: HttpServletRequest, response: HttpServletResponse, name: String) =
        setCookie(request, response, name, "", Duration.ZERO)

    private fun cookie(request: HttpServletRequest, name: String): String? =
        request.cookies?.firstOrNull { it.name == name }?.value

    private fun secureRequest(request: HttpServletRequest): Boolean =
        request.isSecure || request.getHeader("X-Forwarded-Proto") == "https"

    private fun secureCookieName(request: HttpServletRequest, name: String): String =
        if (secureRequest(request)) "__Host-$name" else name

    private companion object {
        const val PAIRING_HANDOFF_COOKIE = "jb_pairing_handoff"
        const val PENDING_CLAIM_COOKIE = "jb_pending_claim"
        const val DEVICE_COOKIE = "jb_device"
    }
}
