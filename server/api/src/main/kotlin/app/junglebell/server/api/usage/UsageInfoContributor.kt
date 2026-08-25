package app.junglebell.server.api.usage

import app.junglebell.server.common.config.JungleBellProperties
import app.junglebell.server.domain.usage.USAGE_AGGREGATION_SUCCESS_MARKER_NAME
import app.junglebell.server.domain.usage.UsageStore
import java.time.Clock
import java.time.Duration
import java.time.Instant
import org.slf4j.LoggerFactory
import org.springframework.boot.actuate.info.Info
import org.springframework.boot.actuate.info.InfoContributor
import org.springframework.stereotype.Component

@Component
class UsageInfoContributor(
    private val store: UsageStore,
    properties: JungleBellProperties,
    private val clock: Clock,
) : InfoContributor {
    private val logger = LoggerFactory.getLogger(javaClass)
    private val configured = properties.usage.enabled

    override fun contribute(builder: Info.Builder) {
        val details = try {
            availableDetails(store.lastAggregationSuccess(USAGE_AGGREGATION_SUCCESS_MARKER_NAME))
        } catch (error: RuntimeException) {
            logger.warn("Usage aggregation status query failed.", error)
            linkedMapOf(
                "configured" to configured,
                "database" to "unavailable",
                "aggregation" to "unavailable",
            )
        }
        builder.withDetail("usageMetrics", details)
    }

    private fun availableDetails(completedAtEpochMs: Long?): Map<String, Any> {
        val details = linkedMapOf<String, Any>(
            "configured" to configured,
            "database" to "available",
            "aggregation" to aggregationStatus(completedAtEpochMs),
        )
        if (completedAtEpochMs != null) {
            details["lastSuccessfulAggregationAt"] = Instant.ofEpochMilli(completedAtEpochMs).toString()
        }
        return details
    }

    private fun aggregationStatus(completedAtEpochMs: Long?): String {
        if (completedAtEpochMs == null) return "never"
        val staleBefore = clock.instant().minus(STALE_AFTER)
        return if (Instant.ofEpochMilli(completedAtEpochMs).isBefore(staleBefore)) "stale" else "fresh"
    }

    private companion object {
        val STALE_AFTER: Duration = Duration.ofMinutes(130)
    }
}
