package app.junglebell.server.domain.pairing

import app.junglebell.server.common.error.ApiException
import app.junglebell.server.common.config.JungleBellProperties
import app.junglebell.server.domain.security.SessionPrincipal
import app.junglebell.server.domain.security.TokenCodec
import org.springframework.http.HttpStatus
import org.slf4j.LoggerFactory
import org.springframework.stereotype.Service
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.time.Clock
import java.time.Duration
import java.time.Instant
import java.util.UUID

@Service
class PairingService(
    private val store: PairingStore,
    private val tokens: TokenCodec,
    private val properties: JungleBellProperties,
    private val clock: Clock,
) {
    private val logger = LoggerFactory.getLogger(javaClass)
    private val pairingTtl = Duration.ofMinutes(10)
    private val mobileTtl = Duration.ofDays(30)

    fun create(principal: SessionPrincipal): PairingCreated {
        logger.info("Pairing creation started.")
        val now = clock.millis()
        val id = UUID.randomUUID()
        val pairingId = "jbp_$id"
        val challenge = tokens.opaque("jbpc_")
        val manualCode = tokens.manualCode()
        val expiresAt = now + pairingTtl.toMillis()
        store.replaceActive(
            PairingRecord(
                id,
                principal.userId,
                principal.installationId,
                tokens.plainHash(challenge),
                tokens.manualCodeHash(manualCode),
                null,
                "pending",
                null,
                null,
                now,
                expiresAt,
                null,
            ),
        )
        val fragment = "pairing=${encode(pairingId)}&challenge=${encode(challenge)}"
        val response = PairingCreated(
            pairingId,
            properties.publicBaseUrl.resolve("/#$fragment").toString(),
            manualCode,
            Instant.ofEpochMilli(expiresAt).toString(),
        )
        logger.info("Pairing creation completed. pairingId={}", pairingId)
        return response
    }

    fun claimQr(pairingId: String, request: QrPairingClaimRequest): PairingClaim {
        logger.info("QR pairing claim started.")
        val id = parsePairingId(pairingId)
        val pairing = store.findByQr(tokens.plainHash(request.challenge))
            ?.takeIf { it.id == id }
        if (pairing == null) {
            logger.warn("QR pairing claim rejected. reason=pairing_not_found")
            throw ApiException("PAIRING_NOT_FOUND", HttpStatus.NOT_FOUND)
        }
        val response = claim(pairing, request.installationId, request.deviceLabel)
        logger.info("QR pairing claim completed. pairingId={}", pairingId)
        return response
    }

    fun prepareHandoff(pairingId: String, challenge: String): Long {
        logger.info("Pairing install handoff preparation started.")
        val id = parsePairingId(pairingId)
        val pairing = store.findByQr(tokens.plainHash(challenge))
            ?.takeIf { it.id == id }
        if (pairing == null) {
            logger.warn("Pairing install handoff rejected. reason=pairing_not_found")
            throw ApiException("PAIRING_NOT_FOUND", HttpStatus.NOT_FOUND)
        }
        ensurePending(pairing)
        logger.info("Pairing install handoff preparation completed. pairingId={}", pairingId)
        return pairing.expiresAtEpochMs
    }

    fun claimHandoff(challenge: String, request: PairingHandoffClaimRequest): PairingClaim {
        logger.info("Pairing install handoff claim started.")
        if (!challenge.matches(QR_CHALLENGE)) {
            logger.warn("Pairing install handoff claim rejected. reason=handoff_invalid")
            throw ApiException("PAIRING_HANDOFF_INVALID", HttpStatus.UNAUTHORIZED)
        }
        val pairing = store.findByQr(tokens.plainHash(challenge))
        if (pairing == null) {
            logger.warn("Pairing install handoff claim rejected. reason=handoff_invalid")
            throw ApiException("PAIRING_HANDOFF_INVALID", HttpStatus.UNAUTHORIZED)
        }
        val response = claim(pairing, request.installationId, request.deviceLabel)
        logger.info("Pairing install handoff claim completed. pairingId={}", response.claimId)
        return response
    }

    fun claimManual(request: ManualPairingClaimRequest): PairingClaim {
        logger.info("Manual pairing claim started.")
        val normalized = tokens.normalizeManualCode(request.manualCode)
        if (normalized == null) {
            logger.warn("Manual pairing claim rejected. reason=pairing_not_found")
            throw ApiException("PAIRING_NOT_FOUND", HttpStatus.NOT_FOUND)
        }
        val pairing = store.findByManual(tokens.manualCodeHash(normalized))
        if (pairing == null) {
            logger.warn("Manual pairing claim rejected. reason=pairing_not_found")
            throw ApiException("PAIRING_NOT_FOUND", HttpStatus.NOT_FOUND)
        }
        val response = claim(pairing, request.installationId, request.deviceLabel)
        logger.info("Manual pairing claim completed. pairingId={}", response.claimId)
        return response
    }

    fun status(principal: SessionPrincipal, pairingId: String): PairingStatusResponse {
        logger.debug("Pairing status lookup started.")
        val pairing = store.findById(parsePairingId(pairingId))
            ?.takeIf { it.userId == principal.userId && it.desktopInstallationId == principal.installationId }
        if (pairing == null) {
            logger.warn("Pairing status lookup rejected. reason=pairing_not_found")
            throw ApiException("PAIRING_NOT_FOUND", HttpStatus.NOT_FOUND)
        }
        val status = status(pairing)
        val response = PairingStatusResponse(
            status,
            if (status == "claimed") {
                PairingClaimDetails(
                    "jbp_${pairing.id}",
                    pairing.mobileLabel ?: "모바일 기기",
                    pairing.mobileInstallationId?.takeLast(4)?.uppercase() ?: "0000",
                )
            } else null,
        )
        logger.debug("Pairing status lookup completed. pairingId={} pairingStatus={}", pairingId, status)
        return response
    }

    fun approve(principal: SessionPrincipal, pairingId: String, request: PairingApprovalRequest) {
        logger.info("Pairing approval started.")
        if (request.claimId != pairingId) {
            logger.warn("Pairing approval rejected. reason=claim_mismatch")
            throw ApiException("PAIRING_CLAIM_MISMATCH", HttpStatus.CONFLICT)
        }
        val id = parsePairingId(pairingId)
        val pairing = store.findById(id)
            ?.takeIf { it.userId == principal.userId && it.desktopInstallationId == principal.installationId }
        if (pairing == null) {
            logger.warn("Pairing approval rejected. reason=pairing_not_found")
            throw ApiException("PAIRING_NOT_FOUND", HttpStatus.NOT_FOUND)
        }
        val now = clock.millis()
        if (pairing.expiresAtEpochMs <= now) {
            logger.warn("Pairing approval rejected. reason=pairing_expired")
            throw ApiException("PAIRING_EXPIRED", HttpStatus.GONE)
        }
        val receiptHash = pairing.claimReceiptSha256
        val installationId = pairing.mobileInstallationId
        val label = pairing.mobileLabel
        if (pairing.status != "claimed" || receiptHash == null || installationId == null || label == null) {
            logger.warn(
                "Pairing approval rejected. reason={}",
                if (pairing.status == "pending") "pairing_not_claimed" else "pairing_already_used",
            )
            throw ApiException(
                if (pairing.status == "pending") "PAIRING_NOT_CLAIMED" else "PAIRING_ALREADY_USED",
                HttpStatus.CONFLICT,
            )
        }
        val token = tokens.mobileToken(receiptHash)
        val sessionId = UUID.randomUUID()
        if (!store.approveAndCreateMobileSession(
                id,
                principal.installationId,
                sessionId,
                tokens.sessionHash(token),
                now,
                now + mobileTtl.toMillis(),
            )
        ) {
            logger.warn("Pairing approval rejected. reason=pairing_already_used")
            throw ApiException("PAIRING_ALREADY_USED", HttpStatus.CONFLICT)
        }
        logger.info("Pairing approval completed. pairingId={} result=approved", pairingId)
    }

    fun complete(pairingId: String, receipt: String): CompletedPairing {
        logger.info("Pairing completion started.")
        if (!receipt.matches(Regex("^jbcr_[a-f0-9]{64}$"))) {
            logger.warn("Pairing completion rejected. reason=invalid_receipt")
            throw ApiException("PAIRING_RECEIPT_INVALID", HttpStatus.UNAUTHORIZED)
        }
        val pairing = store.findById(parsePairingId(pairingId))
        if (pairing == null) {
            logger.warn("Pairing completion rejected. reason=invalid_receipt")
            throw ApiException("PAIRING_RECEIPT_INVALID", HttpStatus.UNAUTHORIZED)
        }
        val receiptHash = tokens.plainHash(receipt)
        if (pairing.claimReceiptSha256 != receiptHash) {
            logger.warn("Pairing completion rejected. reason=invalid_receipt")
            throw ApiException("PAIRING_RECEIPT_INVALID", HttpStatus.UNAUTHORIZED)
        }
        val now = clock.millis()
        if (pairing.expiresAtEpochMs <= now) {
            logger.warn("Pairing completion rejected. reason=pairing_expired")
            throw ApiException("PAIRING_EXPIRED", HttpStatus.GONE)
        }
        val approvedAt = pairing.approvedAtEpochMs
        if (approvedAt == null || pairing.status !in setOf("approved", "consumed")) {
            logger.warn("Pairing completion rejected. reason=pairing_not_approved")
            throw ApiException("PAIRING_NOT_APPROVED", HttpStatus.CONFLICT)
        }
        val expiresAt = approvedAt + mobileTtl.toMillis()
        if (expiresAt <= now) {
            logger.warn("Pairing completion rejected. reason=mobile_session_expired")
            throw ApiException("PAIRING_EXPIRED", HttpStatus.GONE)
        }
        if (pairing.status == "approved" && !store.consume(pairing.id, receiptHash)) {
            logger.warn("Pairing completion rejected. reason=pairing_already_consumed")
            throw ApiException("PAIRING_EXPIRED", HttpStatus.GONE)
        }
        val response = CompletedPairing(tokens.mobileToken(receiptHash), expiresAt)
        logger.info("Pairing completion completed. pairingId={} result=completed", pairingId)
        return response
    }

    private fun claim(pairing: PairingRecord, installationId: String, label: String): PairingClaim {
        ensurePending(pairing)
        val receipt = tokens.opaque("jbcr_")
        if (!store.claim(pairing.id, tokens.plainHash(receipt), installationId, label.trim())) {
            logger.warn("Pairing claim rejected. pairingId=jbp_{} reason=pairing_already_used", pairing.id)
            throw ApiException("PAIRING_ALREADY_USED", HttpStatus.CONFLICT)
        }
        return PairingClaim("jbp_${pairing.id}", receipt, pairing.expiresAtEpochMs)
    }

    private fun ensurePending(pairing: PairingRecord) {
        if (pairing.expiresAtEpochMs <= clock.millis()) {
            logger.warn("Pairing operation rejected. pairingId=jbp_{} reason=pairing_expired", pairing.id)
            throw ApiException("PAIRING_EXPIRED", HttpStatus.GONE)
        }
        if (pairing.status != "pending") {
            logger.warn("Pairing operation rejected. pairingId=jbp_{} reason=pairing_already_used", pairing.id)
            throw ApiException("PAIRING_ALREADY_USED", HttpStatus.CONFLICT)
        }
    }

    private fun status(pairing: PairingRecord): String = when {
        pairing.status == "consumed" -> "completed"
        pairing.expiresAtEpochMs <= clock.millis() -> "expired"
        else -> pairing.status
    }

    private fun parsePairingId(value: String): UUID = try {
        UUID.fromString(value.removePrefix("jbp_").takeIf { value.startsWith("jbp_") } ?: "")
    } catch (_: IllegalArgumentException) {
        logger.warn("Pairing operation rejected. reason=invalid_pairing_id")
        throw ApiException("INVALID_REQUEST")
    }

    private fun encode(value: String) = URLEncoder.encode(value, StandardCharsets.UTF_8)

    private companion object {
        val QR_CHALLENGE = Regex("^jbpc_[a-f0-9]{64}$")
    }
}

data class PairingClaim(val claimId: String, val receipt: String, val expiresAtEpochMs: Long)
data class CompletedPairing(val token: String, val expiresAtEpochMs: Long)
