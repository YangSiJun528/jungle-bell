package app.junglebell.server.domain.usage

import java.time.LocalDate
import java.util.UUID

interface UsageStore {
    fun tryAcquireAggregationLease(name: String, now: Long, durationMs: Long, token: String): Boolean

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
