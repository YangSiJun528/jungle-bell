package app.junglebell.server.domain.pairing

import app.junglebell.server.common.config.JungleBellProperties
import app.junglebell.server.domain.security.SessionKind
import app.junglebell.server.domain.security.SessionPrincipal
import app.junglebell.server.domain.security.TokenCodec
import java.net.URI
import java.time.Clock
import java.time.Instant
import java.time.ZoneOffset
import java.util.UUID
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class PairingServiceTest {
    @Test
    fun `pairing URL uses the root SPA fragment`() {
        val store = CapturingPairingStore()
        val properties = properties()
        val service = PairingService(
            store,
            TokenCodec(properties),
            properties,
            Clock.fixed(Instant.parse("2026-08-14T00:00:00Z"), ZoneOffset.UTC),
        )

        val created = service.create(
            SessionPrincipal(UUID.randomUUID(), UUID.randomUUID(), "desktop-test", SessionKind.DESKTOP),
        )

        assertNotNull(store.record)
        assertTrue(created.qrPayload.startsWith("https://example.test/#pairing=jbp_"))
        assertTrue(created.qrPayload.contains("&challenge=jbpc_"))
        assertEquals("/", URI.create(created.qrPayload).path)
    }

    private fun properties() = JungleBellProperties(
        URI.create("https://example.test"),
        setOf("tauri://localhost"),
        "test-pairing-secret-that-is-long-enough",
        collectors = JungleBellProperties.CollectorProperties(false, null, null, null),
    )

    private class CapturingPairingStore : PairingStore {
        var record: PairingRecord? = null

        override fun replaceActive(record: PairingRecord) {
            this.record = record
        }

        override fun findById(id: UUID) = error("unused")
        override fun findByQr(hash: String) = error("unused")
        override fun findByManual(hash: String) = error("unused")
        override fun claim(id: UUID, receiptHash: String, installationId: String, label: String) = error("unused")
        override fun approveAndCreateMobileSession(
            pairingId: UUID,
            desktopInstallationId: String,
            sessionId: UUID,
            tokenHash: String,
            now: Long,
            expiresAt: Long,
        ) = error("unused")

        override fun consume(id: UUID, receiptHash: String) = error("unused")
    }
}
