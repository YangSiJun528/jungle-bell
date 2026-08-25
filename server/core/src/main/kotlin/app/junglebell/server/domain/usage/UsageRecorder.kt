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
import org.springframework.dao.DataAccessException
import org.springframework.dao.DataAccessResourceFailureException
import org.springframework.dao.RecoverableDataAccessException
import org.springframework.dao.TransientDataAccessException
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

    fun recordUiOpened(principal: SessionPrincipal): UsageRecordingOutcome {
        if (!settings.enabled) return UsageRecordingOutcome.SKIPPED
        val client = principal.usageClient()

        return recordUiOpen(client) {
            if (store.usagePreference(principal.userId).enabled != true) {
                return@recordUiOpen UsageRecordingOutcome.SKIPPED
            }
            store.recordUserActivity(
                LocalDate.now(clock.withZone(zoneId)),
                principal.userId,
                client,
                UsageActivity.UI_OPENED,
            ).toRecordingOutcome()
        }
    }

    fun recordFeature(principal: SessionPrincipal, feature: UsageFeature) {
        if (!settings.enabled) return
        try {
            if (store.usagePreference(principal.userId).enabled != true) return
            store.incrementFeature(
                LocalDate.now(clock.withZone(zoneId)),
                principal.userId,
                principal.usageClient(),
                feature,
            )
        } catch (error: Exception) {
            logger.warn(
                "Usage metric recording failed. metric={} errorType={}",
                feature.value,
                error.javaClass.simpleName,
            )
        }
    }

    private inline fun recordUiOpen(
        client: UsageClient,
        operation: () -> UsageRecordingOutcome,
    ): UsageRecordingOutcome = try {
        operation()
    } catch (error: DataAccessException) {
        if (!error.isRetryableUsageFailure()) throw error
        logger.warn(
            "Usage metric recording temporarily unavailable. metric=ui_opened client={} errorType={}",
            client.value,
            error.javaClass.simpleName,
        )
        UsageRecordingOutcome.UNAVAILABLE
    }

    private fun SessionPrincipal.usageClient(): UsageClient = when (kind) {
        SessionKind.DESKTOP -> UsageClient.DESKTOP
        SessionKind.MOBILE -> UsageClient.PWA
    }
}

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

    fun recordUiOpened(existingToken: String?, client: UsageClient): AnonymousUsageRecording {
        require(client == UsageClient.WEB || client == UsageClient.PWA)
        if (!settings.enabled) {
            return AnonymousUsageRecording(
                identity = null,
                outcome = UsageRecordingOutcome.SKIPPED,
            )
        }

        val existing = existingToken?.takeIf(VISITOR_TOKEN::matches)
        val token = existing ?: opaqueVisitorToken()
        val identity = AnonymousUsageIdentity(token, existing == null)
        val date = LocalDate.now(clock.withZone(zoneId))
        val outcome = try {
            store.recordAnonymousActivity(
                date,
                visitorHash(date, token),
                client,
                UsageActivity.UI_OPENED,
            ).toRecordingOutcome()
        } catch (error: DataAccessException) {
            if (!error.isRetryableUsageFailure()) throw error
            logger.warn(
                "Anonymous usage metric recording temporarily unavailable. client={} errorType={}",
                client.value,
                error.javaClass.simpleName,
            )
            UsageRecordingOutcome.UNAVAILABLE
        }
        return AnonymousUsageRecording(identity, outcome)
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

private fun Boolean.toRecordingOutcome(): UsageRecordingOutcome =
    if (this) UsageRecordingOutcome.RECORDED else UsageRecordingOutcome.NO_CHANGE

private fun DataAccessException.isRetryableUsageFailure(): Boolean =
    this is TransientDataAccessException ||
        this is RecoverableDataAccessException ||
        this is DataAccessResourceFailureException
