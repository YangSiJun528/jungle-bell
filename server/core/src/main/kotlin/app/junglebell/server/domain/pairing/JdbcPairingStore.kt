package app.junglebell.server.domain.pairing

import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.stereotype.Repository
import org.springframework.transaction.annotation.Transactional
import java.util.UUID

@Repository
class JdbcPairingStore(private val jdbc: JdbcClient) : PairingStore {
    @Transactional
    override fun replaceActive(record: PairingRecord) {
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

    override fun findById(id: UUID): PairingRecord? = query(
        "SELECT * FROM pairing_challenge WHERE id = :value",
        id,
    )

    override fun findByQr(hash: String): PairingRecord? = query(
        "SELECT * FROM pairing_challenge WHERE pairing_secret_sha256 = :value",
        hash,
    )

    override fun findByManual(hash: String): PairingRecord? = query(
        "SELECT * FROM pairing_challenge WHERE manual_code_hash = :value",
        hash,
    )

    override fun claim(id: UUID, receiptHash: String, installationId: String, label: String): Boolean = jdbc.sql(
        """
        UPDATE pairing_challenge
        SET status = 'claimed', claim_receipt_sha256 = :receiptHash,
            mobile_installation_id = :installationId, mobile_label = :label
        WHERE id = :id AND status = 'pending'
        RETURNING id
        """.trimIndent(),
    ).param("receiptHash", receiptHash).param("installationId", installationId)
        .param("label", label).param("id", id).query(UUID::class.java).optional().isPresent

    override fun approveAndCreateMobileSession(
        pairingId: UUID,
        desktopInstallationId: String,
        sessionId: UUID,
        tokenHash: String,
        now: Long,
        expiresAt: Long,
    ): Boolean = jdbc.sql(
        """
        WITH approved AS (
            UPDATE pairing_challenge
            SET status = 'approved', approved_at_epoch_ms = :now
            WHERE id = :pairingId
              AND desktop_installation_id = :desktopInstallationId
              AND status = 'claimed'
              AND expires_at_epoch_ms > :now
              AND mobile_installation_id IS NOT NULL
              AND mobile_label IS NOT NULL
            RETURNING id, user_id, mobile_installation_id, mobile_label
        ), created_session AS (
            INSERT INTO app_session(
                id, user_id, installation_id, kind, label, token_sha256,
                created_at_epoch_ms, expires_at_epoch_ms, last_seen_at_epoch_ms,
                revoked_at_epoch_ms, source_pairing_id
            )
            SELECT :sessionId, user_id, mobile_installation_id, 'mobile', mobile_label,
                :tokenHash, :now, :expiresAt, :now, NULL, id
            FROM approved
            RETURNING source_pairing_id
        )
        SELECT source_pairing_id FROM created_session
        """.trimIndent(),
    ).param("now", now).param("pairingId", pairingId)
        .param("desktopInstallationId", desktopInstallationId).param("sessionId", sessionId)
        .param("tokenHash", tokenHash).param("expiresAt", expiresAt)
        .query(UUID::class.java).optional().isPresent

    override fun consume(id: UUID, receiptHash: String): Boolean = jdbc.sql(
        """
        UPDATE pairing_challenge SET status = 'consumed'
        WHERE id = :id AND claim_receipt_sha256 = :receiptHash AND status = 'approved'
        RETURNING id
        """.trimIndent(),
    ).param("id", id).param("receiptHash", receiptHash).query(UUID::class.java).optional().isPresent

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
            row.getObject("approved_at_epoch_ms", Long::class.javaObjectType),
        )
    }.optional().orElse(null)
}
