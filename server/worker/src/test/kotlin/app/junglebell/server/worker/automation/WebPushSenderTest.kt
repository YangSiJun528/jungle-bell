package app.junglebell.server.worker.automation

import app.junglebell.server.common.config.JungleBellProperties
import nl.martijndwars.webpush.Notification
import nl.martijndwars.webpush.PushService
import org.bouncycastle.jce.ECNamedCurveTable
import org.bouncycastle.jce.provider.BouncyCastleProvider
import java.net.URI
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.Security
import kotlin.test.Test
import kotlin.test.assertEquals
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

    @Test
    fun preservesOriginalFcmSubscriptionEndpoint() {
        if (Security.getProvider(BouncyCastleProvider.PROVIDER_NAME) == null) {
            Security.addProvider(BouncyCastleProvider())
        }
        val subscriberKeys = p256KeyPair()
        val notification = Notification(
            FCM_ENDPOINT,
            subscriberKeys.public,
            ByteArray(16) { it.toByte() },
            "{\"title\":\"test\"}".toByteArray(),
            60,
        )

        val request = prepareWebPushPost(
            PushService(p256KeyPair(), "https://jungle-bell.example"),
            notification,
        )

        assertEquals(FCM_ENDPOINT, request.uri.toString())
    }

    private fun p256KeyPair(): KeyPair = KeyPairGenerator.getInstance("ECDH", BouncyCastleProvider.PROVIDER_NAME)
        .apply { initialize(ECNamedCurveTable.getParameterSpec("prime256v1")) }
        .generateKeyPair()

    private companion object {
        const val FCM_ENDPOINT = "https://fcm.googleapis.com/fcm/send/test-token"
    }
}
