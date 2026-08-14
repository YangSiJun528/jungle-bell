package app.junglebell.server.domain.pairing

import jakarta.validation.constraints.Pattern
import jakarta.validation.constraints.Size

data class PairingCreated(
    val pairingId: String,
    val qrPayload: String,
    val manualCode: String,
    val expiresAt: String,
)

data class QrPairingClaimRequest(
    @field:Pattern(regexp = "^jbpc_[a-f0-9]{64}$") val challenge: String,
    @field:Size(min = 1, max = 80) val deviceLabel: String,
    @field:Pattern(regexp = "^jbmi_[a-f0-9]{32}$") val installationId: String,
)

data class ManualPairingClaimRequest(
    @field:Size(min = 10, max = 32) val manualCode: String,
    @field:Size(min = 1, max = 80) val deviceLabel: String,
    @field:Pattern(regexp = "^jbmi_[a-f0-9]{32}$") val installationId: String,
)

data class PairingClaimResponse(
    val claimId: String,
    val status: String = "awaiting-desktop-approval",
)

data class PairingApprovalRequest(
    @field:Pattern(regexp = "^jbp_[0-9a-f-]{36}$") val claimId: String,
)

data class PairingClaimDetails(
    val claimId: String,
    val deviceLabel: String,
    val confirmationCode: String,
)

data class PairingStatusResponse(
    val status: String,
    val claim: PairingClaimDetails?,
)
