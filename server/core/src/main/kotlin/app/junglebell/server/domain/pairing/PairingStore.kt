package app.junglebell.server.domain.pairing

import java.util.UUID

interface PairingStore {
    fun replaceActive(record: PairingRecord)
    fun findById(id: UUID): PairingRecord?
    fun findByQr(hash: String): PairingRecord?
    fun findByManual(hash: String): PairingRecord?
    fun claim(id: UUID, receiptHash: String, installationId: String, label: String): Boolean

    /** 페어링 승인과 모바일 세션 생성을 하나의 원자적 저장 작업으로 처리합니다. */
    fun approveAndCreateMobileSession(
        pairingId: UUID,
        desktopInstallationId: String,
        sessionId: UUID,
        tokenHash: String,
        now: Long,
        expiresAt: Long,
    ): Boolean

    fun consume(id: UUID, receiptHash: String): Boolean
}

data class PairingRecord(
    val id: UUID,
    val userId: UUID,
    val desktopInstallationId: String,
    val pairingSecretSha256: String,
    val manualCodeHash: String,
    val claimReceiptSha256: String?,
    val status: String,
    val mobileInstallationId: String?,
    val mobileLabel: String?,
    val createdAtEpochMs: Long,
    val expiresAtEpochMs: Long,
    val approvedAtEpochMs: Long?,
)
