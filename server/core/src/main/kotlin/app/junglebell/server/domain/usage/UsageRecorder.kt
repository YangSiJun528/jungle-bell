package app.junglebell.server.domain.usage

import app.junglebell.server.common.config.JungleBellProperties
import app.junglebell.server.domain.security.SessionKind
import app.junglebell.server.domain.security.SessionPrincipal
import java.nio.charset.StandardCharsets
import java.security.SecureRandom
import java.time.Clock
import java.time.LocalDate
import java.time.ZoneId
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import org.slf4j.LoggerFactory
import org.springframework.stereotype.Service

@Service
class UsageRecorder(
    private val store: UsageStore,
    properties: JungleBellProperties,
    private val clock: Clock,
) {
    private val settings = properties.usage
    private val zoneId = ZoneId.of(settings.zoneId)
    private val logger = LoggerFactory.getLogger(javaClass)

    fun recordUiOpened(principal: SessionPrincipal) = bestEffort("ui_opened") {
        store.recordUserActivity(
            LocalDate.now(clock.withZone(zoneId)),
            principal.userId,
            principal.usageClient(),
            UsageActivity.UI_OPENED,
        )
    }

    fun recordFeature(principal: SessionPrincipal, feature: UsageFeature) = bestEffort(feature.value) {
        store.incrementFeature(
            LocalDate.now(clock.withZone(zoneId)),
            principal.userId,
            principal.usageClient(),
            feature,
        )
    }

    private inline fun bestEffort(metric: String, operation: () -> Unit) {
        if (!settings.enabled) return
        try {
            operation()
        } catch (error: Exception) {
            logger.warn("Usage metric recording failed. metric={} errorType={}", metric, error.javaClass.simpleName)
        }
    }

    private fun SessionPrincipal.usageClient(): UsageClient = when (kind) {
        SessionKind.DESKTOP -> UsageClient.DESKTOP
        SessionKind.MOBILE -> UsageClient.PWA
    }
}

data class AnonymousUsageIdentity(val token: String, val newToken: Boolean)

@Service
class AnonymousUsageRecorder(
    private val store: UsageStore,
    properties: JungleBellProperties,
    private val clock: Clock,
) {
    private val settings = properties.usage
    private val zoneId = ZoneId.of(settings.zoneId)
    private val secret = settings.anonymousHashSecret.toByteArray(StandardCharsets.UTF_8)
    private val random = SecureRandom()
    private val logger = LoggerFactory.getLogger(javaClass)

    fun recordUiOpened(existingToken: String?, client: UsageClient): AnonymousUsageIdentity? {
        require(client == UsageClient.WEB || client == UsageClient.PWA)
        if (!settings.enabled) return null

        val existing = existingToken?.takeIf(VISITOR_TOKEN::matches)
        val token = existing ?: opaqueVisitorToken()
        val date = LocalDate.now(clock.withZone(zoneId))
        try {
            store.recordAnonymousActivity(
                date,
                visitorHash(date, token),
                client,
                UsageActivity.UI_OPENED,
            )
        } catch (error: Exception) {
            logger.warn(
                "Anonymous usage metric recording failed. client={} errorType={}",
                client.value,
                error.javaClass.simpleName,
            )
        }
        return AnonymousUsageIdentity(token, existing == null)
    }

    private fun opaqueVisitorToken(): String =
        "jbv_" + ByteArray(32).also(random::nextBytes).toHex()

    private fun visitorHash(date: LocalDate, token: String): String {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(secret, "HmacSHA256"))
        return mac.doFinal("jungle-bell:anonymous-usage:v1\u0000$date\u0000$token".toByteArray(StandardCharsets.UTF_8))
            .toHex()
    }

    private fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it) }

    private companion object {
        val VISITOR_TOKEN = Regex("^jbv_[a-f0-9]{64}$")
    }
}
