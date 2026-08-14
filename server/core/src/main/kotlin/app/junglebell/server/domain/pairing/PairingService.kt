package app.junglebell.server.domain.pairing

import app.junglebell.server.common.error.ApiException
import app.junglebell.server.common.config.JungleBellProperties
import app.junglebell.server.domain.security.SessionPrincipal
import app.junglebell.server.domain.security.TokenCodec
import org.springframework.http.HttpStatus
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
    private val pairingTtl = Duration.ofMinutes(2)
    private val mobileTtl = Duration.ofDays(30)

    fun create(principal: SessionPrincipal): PairingCreated {
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
        return PairingCreated(
            pairingId,
            properties.publicBaseUrl.resolve("/#$fragment").toString(),
            manualCode,
            Instant.ofEpochMilli(expiresAt).toString(),
        )
    }

    fun claimQr(pairingId: String, request: QrPairingClaimRequest): PairingClaim {
        val id = parsePairingId(pairingId)
        val pairing = store.findByQr(tokens.plainHash(request.challenge))
            ?.takeIf { it.id == id }
            ?: throw ApiException("PAIRING_NOT_FOUND", HttpStatus.NOT_FOUND)
        return claim(pairing, request.installationId, request.deviceLabel)
    }

    fun claimManual(request: ManualPairingClaimRequest): PairingClaim {
        val normalized = tokens.normalizeManualCode(request.manualCode)
            ?: throw ApiException("PAIRING_NOT_FOUND", HttpStatus.NOT_FOUND)
        val pairing = store.findByManual(tokens.manualCodeHash(normalized))
            ?: throw ApiException("PAIRING_NOT_FOUND", HttpStatus.NOT_FOUND)
        return claim(pairing, request.installationId, request.deviceLabel)
    }

    fun status(principal: SessionPrincipal, pairingId: String): PairingStatusResponse {
        val pairing = store.findById(parsePairingId(pairingId))
            ?.takeIf { it.userId == principal.userId && it.desktopInstallationId == principal.installationId }
            ?: throw ApiException("PAIRING_NOT_FOUND", HttpStatus.NOT_FOUND)
        val status = status(pairing)
        return PairingStatusResponse(
            status,
            if (status == "claimed") {
                PairingClaimDetails(
                    "jbp_${pairing.id}",
                    pairing.mobileLabel ?: "모바일 기기",
                    pairing.mobileInstallationId?.takeLast(4)?.uppercase() ?: "0000",
                )
            } else null,
        )
    }

    fun approve(principal: SessionPrincipal, pairingId: String, request: PairingApprovalRequest) {
        if (request.claimId != pairingId) throw ApiException("PAIRING_CLAIM_MISMATCH", HttpStatus.CONFLICT)
        val id = parsePairingId(pairingId)
        val pairing = store.findById(id)
            ?.takeIf { it.userId == principal.userId && it.desktopInstallationId == principal.installationId }
            ?: throw ApiException("PAIRING_NOT_FOUND", HttpStatus.NOT_FOUND)
        val now = clock.millis()
        if (pairing.expiresAtEpochMs <= now) throw ApiException("PAIRING_EXPIRED", HttpStatus.GONE)
        val receiptHash = pairing.claimReceiptSha256
        val installationId = pairing.mobileInstallationId
        val label = pairing.mobileLabel
        if (pairing.status != "claimed" || receiptHash == null || installationId == null || label == null) {
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
            throw ApiException("PAIRING_ALREADY_USED", HttpStatus.CONFLICT)
        }
    }

    fun complete(pairingId: String, receipt: String): CompletedPairing {
        if (!receipt.matches(Regex("^jbcr_[a-f0-9]{64}$"))) {
            throw ApiException("PAIRING_RECEIPT_INVALID", HttpStatus.UNAUTHORIZED)
        }
        val pairing = store.findById(parsePairingId(pairingId))
            ?: throw ApiException("PAIRING_RECEIPT_INVALID", HttpStatus.UNAUTHORIZED)
        val receiptHash = tokens.plainHash(receipt)
        if (pairing.claimReceiptSha256 != receiptHash) {
            throw ApiException("PAIRING_RECEIPT_INVALID", HttpStatus.UNAUTHORIZED)
        }
        val now = clock.millis()
        if (pairing.expiresAtEpochMs <= now) throw ApiException("PAIRING_EXPIRED", HttpStatus.GONE)
        val approvedAt = pairing.approvedAtEpochMs
        if (approvedAt == null || pairing.status !in setOf("approved", "consumed")) {
            throw ApiException("PAIRING_NOT_APPROVED", HttpStatus.CONFLICT)
        }
        val expiresAt = approvedAt + mobileTtl.toMillis()
        if (expiresAt <= now) throw ApiException("PAIRING_EXPIRED", HttpStatus.GONE)
        if (pairing.status == "approved" && !store.consume(pairing.id, receiptHash)) {
            throw ApiException("PAIRING_EXPIRED", HttpStatus.GONE)
        }
        return CompletedPairing(tokens.mobileToken(receiptHash), expiresAt)
    }

    private fun claim(pairing: PairingRecord, installationId: String, label: String): PairingClaim {
        val now = clock.millis()
        if (pairing.expiresAtEpochMs <= now) throw ApiException("PAIRING_EXPIRED", HttpStatus.GONE)
        if (pairing.status != "pending") throw ApiException("PAIRING_ALREADY_USED", HttpStatus.CONFLICT)
        val receipt = tokens.opaque("jbcr_")
        if (!store.claim(pairing.id, tokens.plainHash(receipt), installationId, label.trim())) {
            throw ApiException("PAIRING_ALREADY_USED", HttpStatus.CONFLICT)
        }
        return PairingClaim("jbp_${pairing.id}", receipt, pairing.expiresAtEpochMs)
    }

    private fun status(pairing: PairingRecord): String = when {
        pairing.status == "consumed" -> "completed"
        pairing.expiresAtEpochMs <= clock.millis() -> "expired"
        else -> pairing.status
    }

    private fun parsePairingId(value: String): UUID = try {
        UUID.fromString(value.removePrefix("jbp_").takeIf { value.startsWith("jbp_") } ?: "")
    } catch (_: IllegalArgumentException) {
        throw ApiException("INVALID_REQUEST")
    }

    private fun encode(value: String) = URLEncoder.encode(value, StandardCharsets.UTF_8)
}

data class PairingClaim(val claimId: String, val receipt: String, val expiresAtEpochMs: Long)
data class CompletedPairing(val token: String, val expiresAtEpochMs: Long)
