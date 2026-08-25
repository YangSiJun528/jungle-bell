package app.junglebell.server.domain.usage

import app.junglebell.server.common.config.JungleBellProperties
import java.net.URI
import java.time.Clock
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset
import java.util.UUID
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull

class UsageAggregationServiceTest {
    private val now = Instant.parse("2026-08-20T01:00:00Z")

    @Test
    fun `hourly run rebuilds current recent and retained raw dates before purging`() {
        val store = AggregationStore(
            rawDates = setOf(LocalDate.of(2026, 7, 22), LocalDate.of(2026, 8, 10)),
        )
        val result = UsageAggregationService(store, properties(), Clock.fixed(now, ZoneOffset.UTC)).runHourly()

        assertEquals(
            listOf(
                SummaryRebuild(
                    LocalDate.of(2026, 7, 22),
                    setOf(UsageSummaryScope.AUTHENTICATED_FEATURE),
                ),
                SummaryRebuild(
                    LocalDate.of(2026, 8, 10),
                    setOf(UsageSummaryScope.AUTHENTICATED_FEATURE),
                ),
                SummaryRebuild(LocalDate.of(2026, 8, 19), UsageSummaryScope.entries.toSet()),
                SummaryRebuild(LocalDate.of(2026, 8, 20), UsageSummaryScope.entries.toSet()),
            ),
            store.rebuilt,
        )
        assertEquals(
            UsageCutoffs(
                anonymousBefore = LocalDate.of(2026, 8, 18),
                userActivityBefore = LocalDate.of(2026, 8, 13),
                featureBefore = LocalDate.of(2026, 7, 21),
                summaryBefore = LocalDate.of(2024, 8, 20),
            ),
            store.cutoffs,
        )
        assertEquals(4, result?.rebuiltDays)
        assertEquals(
            listOf(USAGE_AGGREGATION_SUCCESS_MARKER_NAME to now.toEpochMilli()),
            store.successMarkers,
        )
    }

    @Test
    fun `disabled metrics skip rebuilds but continue retention cleanup`() {
        val disabledStore = AggregationStore()
        val result = UsageAggregationService(
            disabledStore,
            properties(enabled = false),
            Clock.fixed(now, ZoneOffset.UTC),
        ).runHourly()

        assertEquals(1, disabledStore.leaseAttempts)
        assertEquals(emptyList(), disabledStore.rebuilt)
        assertEquals(0, result?.rebuiltDays)
        assertEquals(
            UsageCutoffs(
                anonymousBefore = LocalDate.of(2026, 8, 18),
                userActivityBefore = LocalDate.of(2026, 8, 13),
                featureBefore = LocalDate.of(2026, 7, 21),
                summaryBefore = LocalDate.of(2024, 8, 20),
            ),
            disabledStore.cutoffs,
        )
        assertEquals(
            listOf(USAGE_AGGREGATION_SUCCESS_MARKER_NAME to now.toEpochMilli()),
            disabledStore.successMarkers,
        )
    }

    @Test
    fun `unavailable lease skips aggregation and cleanup`() {
        val leasedStore = AggregationStore(leaseGranted = false)
        assertNull(UsageAggregationService(leasedStore, properties(), Clock.fixed(now, ZoneOffset.UTC)).runHourly())
        assertEquals(emptyList(), leasedStore.rebuilt)
        assertNull(leasedStore.cutoffs)
        assertEquals(emptyList(), leasedStore.successMarkers)
    }

    @Test
    fun `rebuild failure does not update the success marker`() {
        val failedStore = AggregationStore(failRebuild = true)

        assertFailsWith<IllegalStateException> {
            UsageAggregationService(failedStore, properties(), Clock.fixed(now, ZoneOffset.UTC)).runHourly()
        }

        assertNull(failedStore.cutoffs)
        assertEquals(emptyList(), failedStore.successMarkers)
    }

    @Test
    fun `purge failure does not update the success marker`() {
        val failedStore = AggregationStore(failPurge = true)

        assertFailsWith<IllegalStateException> {
            UsageAggregationService(failedStore, properties(), Clock.fixed(now, ZoneOffset.UTC)).runHourly()
        }

        assertEquals(emptyList(), failedStore.successMarkers)
    }

    private fun properties(enabled: Boolean = true) = JungleBellProperties(
        publicBaseUrl = URI("https://example.test"),
        allowedDesktopOrigins = emptySet(),
        pairingSecret = "p".repeat(32),
        collectors = JungleBellProperties.CollectorProperties(false, null, null, null),
        usage = JungleBellProperties.UsageProperties(
            enabled = enabled,
            anonymousHashSecret = "s".repeat(32),
        ),
    )

    private data class UsageCutoffs(
        val anonymousBefore: LocalDate,
        val userActivityBefore: LocalDate,
        val featureBefore: LocalDate,
        val summaryBefore: LocalDate,
    )

    private data class SummaryRebuild(
        val date: LocalDate,
        val scopes: Set<UsageSummaryScope>,
    )

    private class AggregationStore(
        private val leaseGranted: Boolean = true,
        private val rawDates: Set<LocalDate> = emptySet(),
        private val failRebuild: Boolean = false,
        private val failPurge: Boolean = false,
    ) : UsageStore {
        var leaseAttempts = 0
        val rebuilt = mutableListOf<SummaryRebuild>()
        val successMarkers = mutableListOf<Pair<String, Long>>()
        var cutoffs: UsageCutoffs? = null

        override fun tryAcquireAggregationLease(name: String, now: Long, durationMs: Long, token: String): Boolean {
            leaseAttempts += 1
            return leaseGranted
        }

        override fun usagePreference(userId: UUID) = UsagePreference(true)
        override fun putUsagePreference(userId: UUID, enabled: Boolean, now: Long) = UsagePreference(enabled)

        override fun rawDatesOnOrAfter(date: LocalDate): Set<LocalDate> = rawDates
        override fun rebuildSummary(
            date: LocalDate,
            calculatedAtEpochMs: Long,
            scopes: Set<UsageSummaryScope>,
        ) {
            check(!failRebuild) { "rebuild failed" }
            rebuilt += SummaryRebuild(date, scopes)
        }

        override fun purge(
            anonymousBefore: LocalDate,
            userActivityBefore: LocalDate,
            featureBefore: LocalDate,
            summaryBefore: LocalDate,
        ): UsagePurgeResult {
            check(!failPurge) { "purge failed" }
            cutoffs = UsageCutoffs(anonymousBefore, userActivityBefore, featureBefore, summaryBefore)
            return UsagePurgeResult(1, 2, 3, 4)
        }

        override fun markAggregationSuccess(name: String, completedAtEpochMs: Long) {
            check(cutoffs != null) { "success marker must follow purge" }
            successMarkers += name to completedAtEpochMs
        }

        override fun lastAggregationSuccess(name: String): Long? =
            successMarkers.lastOrNull { it.first == name }?.second

        override fun recordUserActivity(
            date: LocalDate,
            userId: UUID,
            client: UsageClient,
            activity: UsageActivity,
        ) = false

        override fun recordAnonymousActivity(
            date: LocalDate,
            visitorHash: String,
            client: UsageClient,
            activity: UsageActivity,
        ) = false

        override fun incrementFeature(
            date: LocalDate,
            userId: UUID,
            client: UsageClient,
            feature: UsageFeature,
        ) = 0L
    }
}
