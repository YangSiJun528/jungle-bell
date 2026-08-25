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
        if (
            !store.tryAcquireAggregationLease(
                USAGE_AGGREGATION_LEASE_NAME,
                now,
                LEASE_DURATION_MS,
                UUID.randomUUID().toString(),
            )
        ) {
            return null
        }

        val today = LocalDate.now(clock.withZone(zoneId))
        val anonymousBefore = today.minusDays(settings.anonymousRetentionDays)
        val userActivityBefore = today.minusDays(settings.userActivityRetentionDays)
        val featureBefore = today.minusDays(settings.featureRetentionDays)
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
        dates.forEach { date ->
            val scopes = buildSet {
                if (!date.isBefore(userActivityBefore)) add(UsageSummaryScope.AUTHENTICATED_ACTIVITY)
                if (!date.isBefore(featureBefore)) add(UsageSummaryScope.AUTHENTICATED_FEATURE)
                if (!date.isBefore(anonymousBefore)) add(UsageSummaryScope.ANONYMOUS_ACTIVITY)
            }
            store.rebuildSummary(date, now, scopes)
        }

        val purge = store.purge(
            anonymousBefore = anonymousBefore,
            userActivityBefore = userActivityBefore,
            featureBefore = featureBefore,
            summaryBefore = today.minusDays(settings.summaryRetentionDays),
        )
        store.markAggregationSuccess(USAGE_AGGREGATION_SUCCESS_MARKER_NAME, clock.millis())
        return UsageAggregationResult(dates.size, purge)
    }

    private companion object {
        const val LEASE_DURATION_MS = 55 * 60_000L
    }
}
