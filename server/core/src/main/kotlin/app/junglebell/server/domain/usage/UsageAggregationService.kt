package app.junglebell.server.domain.usage

import app.junglebell.server.common.config.JungleBellProperties
import java.time.Clock
import java.time.LocalDate
import java.time.ZoneId
import java.util.UUID
import org.springframework.stereotype.Service

data class UsageAggregationResult(
    val rebuiltDays: Int,
    val purge: UsagePurgeResult,
)

@Service
class UsageAggregationService(
    private val store: UsageStore,
    properties: JungleBellProperties,
    private val clock: Clock,
) {
    private val settings = properties.usage
    private val zoneId = ZoneId.of(settings.zoneId)

    fun runHourly(): UsageAggregationResult? {
        val now = clock.millis()
        if (!store.tryAcquireAggregationLease(LEASE_NAME, now, LEASE_DURATION_MS, UUID.randomUUID().toString())) {
            return null
        }

        val today = LocalDate.now(clock.withZone(zoneId))
        val dates = if (settings.enabled) {
            val oldestRawDate = today.minusDays(
                maxOf(
                    settings.anonymousRetentionDays,
                    settings.userActivityRetentionDays,
                    settings.featureRetentionDays,
                ),
            )
            buildSet {
                add(today.minusDays(1))
                add(today)
                addAll(store.rawDatesOnOrAfter(oldestRawDate))
            }.sorted()
        } else {
            emptyList()
        }
        dates.forEach { store.rebuildSummary(it, now) }

        val purge = store.purge(
            anonymousBefore = today.minusDays(settings.anonymousRetentionDays),
            userActivityBefore = today.minusDays(settings.userActivityRetentionDays),
            featureBefore = today.minusDays(settings.featureRetentionDays),
            summaryBefore = today.minusDays(settings.summaryRetentionDays),
        )
        return UsageAggregationResult(dates.size, purge)
    }

    private companion object {
        const val LEASE_NAME = "usage-daily-summary-v1"
        const val LEASE_DURATION_MS = 55 * 60_000L
    }
}
