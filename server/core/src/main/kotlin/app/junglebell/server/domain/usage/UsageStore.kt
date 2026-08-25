package app.junglebell.server.domain.usage

import java.time.LocalDate
import java.util.UUID

const val USAGE_AGGREGATION_LEASE_NAME = "usage-daily-summary-v1"
const val USAGE_AGGREGATION_SUCCESS_MARKER_NAME = "$USAGE_AGGREGATION_LEASE_NAME:success"

interface UsageStore {
    fun tryAcquireAggregationLease(name: String, now: Long, durationMs: Long, token: String): Boolean
    fun markAggregationSuccess(name: String, completedAtEpochMs: Long)
    fun lastAggregationSuccess(name: String): Long?

    fun usagePreference(userId: UUID): UsagePreference
    fun putUsagePreference(userId: UUID, enabled: Boolean, now: Long): UsagePreference

    fun recordUserActivity(
        date: LocalDate,
        userId: UUID,
        client: UsageClient,
        activity: UsageActivity,
    ): Boolean

    fun recordAnonymousActivity(
        date: LocalDate,
        visitorHash: String,
        client: UsageClient,
        activity: UsageActivity,
    ): Boolean

    fun incrementFeature(
        date: LocalDate,
        userId: UUID,
        client: UsageClient,
        feature: UsageFeature,
    ): Long

    fun rebuildSummary(
        date: LocalDate,
        calculatedAtEpochMs: Long,
        scopes: Set<UsageSummaryScope>,
    )
    fun rawDatesOnOrAfter(date: LocalDate): Set<LocalDate>
    fun purge(
        anonymousBefore: LocalDate,
        userActivityBefore: LocalDate,
        featureBefore: LocalDate,
        summaryBefore: LocalDate,
    ): UsagePurgeResult
}
