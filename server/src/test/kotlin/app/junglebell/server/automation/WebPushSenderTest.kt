package app.junglebell.server.automation

import app.junglebell.server.config.JungleBellProperties
import java.net.URI
import java.security.Security
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertNotNull

class WebPushSenderTest {
    @Test
    fun registersBouncyCastleEvenWhenWebPushIsDisabled() {
        Security.removeProvider("BC")

        val sender = WebPushSender(
            JungleBellProperties(
                publicBaseUrl = URI("http://127.0.0.1:8080"),
                allowedDesktopOrigins = emptySet(),
                pairingSecret = "x".repeat(32),
                collectors = JungleBellProperties.CollectorProperties(false, null, null, null),
            ),
        )

        assertFalse(sender.configured)
        assertNotNull(Security.getProvider("BC"))
    }
}
