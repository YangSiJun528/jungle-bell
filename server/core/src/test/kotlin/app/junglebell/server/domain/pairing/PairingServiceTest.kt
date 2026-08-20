package app.junglebell.server.domain.pairing

import app.junglebell.server.common.error.ApiException
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
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class PairingServiceTest {
    @Test
    fun `pairing URL uses the root SPA fragment and allows ten minutes for installation`() {
        val store = CapturingPairingStore()
        val properties = properties()
        val now = Instant.parse("2026-08-14T00:00:00Z")
        val service = PairingService(
            store,
            TokenCodec(properties),
            properties,
            Clock.fixed(now, ZoneOffset.UTC),
        )

        val created = service.create(
            SessionPrincipal(UUID.randomUUID(), UUID.randomUUID(), "desktop-test", SessionKind.DESKTOP),
        )

        assertNotNull(store.record)
        assertTrue(created.qrPayload.startsWith("https://example.test/#pairing=jbp_"))
        assertTrue(created.qrPayload.contains("&challenge=jbpc_"))
        assertEquals("/", URI.create(created.qrPayload).path)
        assertEquals(now.toEpochMilli() + 10 * 60_000, store.record?.expiresAtEpochMs)
    }

    @Test
    fun `install handoff validates the QR without claiming until the PWA opens`() {
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
        val challenge = URI.create(created.qrPayload).fragment.substringAfter("challenge=")

        assertEquals(store.record?.expiresAtEpochMs, service.prepareHandoff(created.pairingId, challenge))
        assertEquals(0, store.claimCount)

        val claim = service.claimHandoff(
            challenge,
            PairingHandoffClaimRequest(
                "설치된 Jungle Bell",
                "jbmi_0123456789abcdef0123456789abcdef",
            ),
        )

        assertEquals(created.pairingId, claim.claimId)
        assertEquals(1, store.claimCount)
        assertEquals("jbmi_0123456789abcdef0123456789abcdef", store.claimedInstallationId)
        assertEquals("설치된 Jungle Bell", store.claimedLabel)
    }

    @Test
    fun `install handoff rejects an invalid cookie value before store lookup`() {
        val store = CapturingPairingStore()
        val properties = properties()
        val service = PairingService(
            store,
            TokenCodec(properties),
            properties,
            Clock.fixed(Instant.parse("2026-08-14T00:00:00Z"), ZoneOffset.UTC),
        )

        val error = assertFailsWith<ApiException> {
            service.claimHandoff(
                "not-a-handoff",
                PairingHandoffClaimRequest(
                    "설치된 Jungle Bell",
                    "jbmi_0123456789abcdef0123456789abcdef",
                ),
            )
        }

        assertEquals("PAIRING_HANDOFF_INVALID", error.code)
        assertEquals(0, store.qrLookupCount)
    }

    private fun properties() = JungleBellProperties(
        URI.create("https://example.test"),
        setOf("tauri://localhost"),
        "test-pairing-secret-that-is-long-enough",
        collectors = JungleBellProperties.CollectorProperties(false, null, null, null),
    )

    private class CapturingPairingStore : PairingStore {
        var record: PairingRecord? = null
        var qrLookupCount = 0
        var claimCount = 0
        var claimedInstallationId: String? = null
        var claimedLabel: String? = null

        override fun replaceActive(record: PairingRecord) {
            this.record = record
        }

        override fun findById(id: UUID) = record?.takeIf { it.id == id }
        override fun findByQr(hash: String): PairingRecord? {
            qrLookupCount += 1
            return record?.takeIf { it.pairingSecretSha256 == hash }
        }
        override fun findByManual(hash: String) = error("unused")
        override fun claim(id: UUID, receiptHash: String, installationId: String, label: String): Boolean {
            claimCount += 1
            claimedInstallationId = installationId
            claimedLabel = label
            return record?.id == id
        }
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
