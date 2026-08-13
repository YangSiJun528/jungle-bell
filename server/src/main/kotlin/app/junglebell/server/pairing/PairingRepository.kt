package app.junglebell.server.pairing

import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.stereotype.Repository
import java.util.UUID

@Repository
class PairingRepository(private val jdbc: JdbcClient) {
    fun replaceActive(record: PairingRecord) {
        jdbc.sql(
            """
            DELETE FROM pairing_challenge
            WHERE user_id = :userId AND desktop_installation_id = :installationId
              AND status IN ('pending', 'claimed', 'approved')
            """.trimIndent(),
        ).param("userId", record.userId).param("installationId", record.desktopInstallationId).update()
        jdbc.sql(
            """
            INSERT INTO pairing_challenge(
                id, user_id, desktop_installation_id, pairing_secret_sha256,
                manual_code_hash, claim_receipt_sha256, status, mobile_installation_id,
                mobile_label, created_at_epoch_ms, expires_at_epoch_ms, approved_at_epoch_ms
            ) VALUES (:id, :userId, :installationId, :secretHash, :manualHash,
                NULL, 'pending', NULL, NULL, :createdAt, :expiresAt, NULL)
            """.trimIndent(),
        ).param("id", record.id).param("userId", record.userId)
            .param("installationId", record.desktopInstallationId)
            .param("secretHash", record.pairingSecretSha256).param("manualHash", record.manualCodeHash)
            .param("createdAt", record.createdAtEpochMs).param("expiresAt", record.expiresAtEpochMs).update()
    }

    fun findById(id: UUID): PairingRecord? = query(
        "SELECT * FROM pairing_challenge WHERE id = :value",
        id,
    )

    fun findByQr(hash: String): PairingRecord? = query(
        "SELECT * FROM pairing_challenge WHERE pairing_secret_sha256 = :value",
        hash,
    )

    fun findByManual(hash: String): PairingRecord? = query(
        "SELECT * FROM pairing_challenge WHERE manual_code_hash = :value",
        hash,
    )

    fun claim(id: UUID, receiptHash: String, installationId: String, label: String): Boolean = jdbc.sql(
        """
        UPDATE pairing_challenge
        SET status = 'claimed', claim_receipt_sha256 = :receiptHash,
            mobile_installation_id = :installationId, mobile_label = :label
        WHERE id = :id AND status = 'pending'
        """.trimIndent(),
    ).param("receiptHash", receiptHash).param("installationId", installationId)
        .param("label", label).param("id", id).update() == 1

    fun approve(id: UUID, desktopInstallationId: String, now: Long): Boolean = jdbc.sql(
        """
        UPDATE pairing_challenge SET status = 'approved', approved_at_epoch_ms = :now
        WHERE id = :id AND desktop_installation_id = :installationId AND status = 'claimed'
        """.trimIndent(),
    ).param("now", now).param("id", id).param("installationId", desktopInstallationId).update() == 1

    fun consume(id: UUID, receiptHash: String): Boolean = jdbc.sql(
        """
        UPDATE pairing_challenge SET status = 'consumed'
        WHERE id = :id AND claim_receipt_sha256 = :receiptHash AND status = 'approved'
        """.trimIndent(),
    ).param("id", id).param("receiptHash", receiptHash).update() == 1

    private fun query(sql: String, value: Any): PairingRecord? = jdbc.sql(sql).param("value", value).query { row, _ ->
        PairingRecord(
            row.getObject("id", UUID::class.java),
            row.getObject("user_id", UUID::class.java),
            row.getString("desktop_installation_id"),
            row.getString("pairing_secret_sha256"),
            row.getString("manual_code_hash"),
            row.getString("claim_receipt_sha256"),
            row.getString("status"),
            row.getString("mobile_installation_id"),
            row.getString("mobile_label"),
            row.getLong("created_at_epoch_ms"),
            row.getLong("expires_at_epoch_ms"),
            row.getObject("approved_at_epoch_ms", java.lang.Long::class.java)?.toLong(),
        )
    }.optional().orElse(null)
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
