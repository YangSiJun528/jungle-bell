package app.junglebell.server.domain.security

import app.junglebell.server.common.config.JungleBellProperties
import java.net.URI
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class TokenCodecTest {
    private val codec = TokenCodec(
        JungleBellProperties(
            publicBaseUrl = URI("https://example.test"),
            allowedDesktopOrigins = emptySet(),
            pairingSecret = "s".repeat(32),
            collectors = JungleBellProperties.CollectorProperties(false, null, null, null),
        ),
    )

    @Test
    fun opaqueTokensUseTheRequestedPrefixAndEntropyLength() {
        val first = codec.opaque("jbd_")
        val second = codec.opaque("jbd_")

        assertTrue(first.matches(Regex("^jbd_[a-f0-9]{64}$")))
        assertNotEquals(first, second)
    }

    @Test
    fun sessionNamespacesProduceDifferentHashes() {
        assertNotEquals(codec.sessionHash("same-token"), codec.uiSessionHash("same-token"))
        assertEquals(codec.plainHash("value"), codec.plainHash("value"))
    }

    @Test
    fun manualCodeNormalizationAcceptsVisualAliasesOnly() {
        assertEquals("1012345678", codec.normalizeManualCode("I0-1234 5678"))
        assertNull(codec.normalizeManualCode("too-short"))
        assertNull(codec.normalizeManualCode("!!!!!!!!!!"))
    }
}
