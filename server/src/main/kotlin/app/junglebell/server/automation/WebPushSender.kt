package app.junglebell.server.automation

import app.junglebell.server.config.JungleBellProperties
import nl.martijndwars.webpush.Notification
import nl.martijndwars.webpush.PushService
import org.bouncycastle.jce.provider.BouncyCastleProvider
import org.apache.http.util.EntityUtils
import org.slf4j.LoggerFactory
import org.springframework.stereotype.Component
import java.net.URI
import java.security.Security
import kotlin.math.ceil

@Component
class WebPushSender(properties: JungleBellProperties) {
    private val logger = LoggerFactory.getLogger(javaClass)
    private val publicKey = properties.vapidPublicKey?.trim().orEmpty()
    private val privateKey = properties.vapidPrivateKey?.trim().orEmpty()
    private val subject = properties.vapidSubject?.trim().orEmpty()
    @Suppress("unused")
    private val cryptoProvider = Security.getProvider(BouncyCastleProvider.PROVIDER_NAME)
        ?: BouncyCastleProvider().also(Security::addProvider)
    val configured = publicKey.isNotEmpty() && privateKey.isNotEmpty() && subject.isNotEmpty()
    private val service = if (configured) PushService(publicKey, privateKey, subject) else null

    fun send(delivery: PushDelivery, now: Long): PushResult {
        val pushService = service ?: return PushResult("retry", "WEB_PUSH_NOT_CONFIGURED")
        if (!allowedEndpoint(delivery.endpoint)) return PushResult("gone", "INVALID_PUSH_ENDPOINT")
        val ttl = ceil((delivery.expiresAtEpochMs - now).coerceAtLeast(0) / 1_000.0)
            .toInt().coerceIn(0, 24 * 60 * 60)
        return try {
            val response = pushService.send(
                Notification(delivery.endpoint, delivery.p256dh, delivery.auth, delivery.payloadJson.toByteArray(), ttl),
            )
            val status = response.statusLine.statusCode
            EntityUtils.consumeQuietly(response.entity)
            when {
                status in 200..299 -> PushResult("delivered", null)
                status == 404 || status == 410 -> PushResult("gone", "HTTP_$status")
                else -> PushResult("retry", "HTTP_$status")
            }
        } catch (error: Exception) {
            logger.warn("Web Push request failed for subscription {}", delivery.subscriptionId, error)
            PushResult("retry", "WEB_PUSH_NETWORK_ERROR")
        }
    }

    private fun allowedEndpoint(value: String): Boolean = runCatching {
        val uri = URI(value)
        uri.scheme == "https" && uri.userInfo == null && uri.fragment == null &&
            uri.host?.lowercase() in ALLOWED_HOSTS
    }.getOrDefault(false)

    private companion object {
        val ALLOWED_HOSTS = setOf(
            "fcm.googleapis.com",
            "push.services.mozilla.com",
            "updates.push.services.mozilla.com",
            "web.push.apple.com",
        )
    }
}

data class PushResult(val status: String, val error: String?)
