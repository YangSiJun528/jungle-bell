package app.junglebell.server.domain.publicapi

import app.junglebell.server.common.config.JungleBellProperties
import java.net.URI
import java.time.Clock
import java.time.Instant
import java.time.ZoneOffset
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class PublicDataServiceLaundryRiskTest {
    @Test
    fun `public laundry response adds appliance risk from the previous seven days`() {
        val now = Instant.parse("2026-08-18T12:34:56Z")
        val store = RiskStore(now)
        val service = PublicDataService(
            store,
            Clock.fixed(now, ZoneOffset.UTC),
            JungleBellProperties(
                URI("https://example.test"),
                emptySet(),
                "x".repeat(32),
                collectors = JungleBellProperties.CollectorProperties(false, null, null, null),
            ),
        )

        val snapshot = service.laundry()
        val washer = assertNotNull(snapshot.machines.single().washer)

        assertTrue(snapshot.quality.collectorHealthy)
        assertEquals(6, washer.attempts)
        assertEquals(1, washer.errors)
        assertEquals(100.0 / 6, washer.rate)
        assertEquals("slight", washer.riskLevel)
        assertEquals(Instant.parse("2026-08-11T12:34:30Z"), store.requestedFrom)
        assertEquals(Instant.parse("2026-08-18T12:34:30Z"), store.requestedThrough)
    }

    @Test
    fun `public laundry response exposes unhealthy collector after a failed attempt`() {
        val now = Instant.parse("2026-08-18T12:34:56Z")
        val service = PublicDataService(
            RiskStore(now, consecutiveFailures = 1, lastError = "invalid upstream response"),
            Clock.fixed(now, ZoneOffset.UTC),
            JungleBellProperties(
                URI("https://example.test"),
                emptySet(),
                "x".repeat(32),
                collectors = JungleBellProperties.CollectorProperties(false, null, null, null),
            ),
        )

        val quality = service.laundry().quality

        assertFalse(quality.collectorHealthy)
        assertEquals("STALE", quality.collection)
        assertEquals("COLLECTION_GAP", quality.sourceFreshness)
    }
}

private class RiskStore(
    private val now: Instant,
    private val consecutiveFailures: Int = 0,
    private val lastError: String? = null,
) : PublicDataStore {
    var requestedFrom: Instant? = null
    var requestedThrough: Instant? = null

    override fun latestLaundryVersion() = LaundryVersion(
        sourceVersionSha = "a".repeat(64),
        observedAt = now.toString(),
        machines = listOf(
            LaundryMachine(
                "워시타워_1",
                LaundryAppliance(
                    machineId = "워시타워_1",
                    appliance = "washer",
                    observedAt = now.toString(),
                    state = NormalizedEnum("POWER_OFF", null, true),
                    operationalStatus = "IDLE",
                    remainingMinutes = 0,
                    totalMinutes = 0,
                    startedAt = "1970-01-01T00:00:00Z",
                    estimatedFinishAt = null,
                    remoteControlEnabled = null,
                    cycleCount = null,
                    sessionId = null,
                    errorCode = null,
                ),
                null,
            ),
        ),
        events = emptyList(),
        unknownEnums = emptyList(),
    )

    override fun sourceState(source: String) = SourceState(
        source,
        now.toString(),
        now.toString(),
        "a".repeat(64),
        now.toString(),
        consecutiveFailures,
        lastError,
    )

    override fun laundryRisks(from: Instant, through: Instant): Map<LaundryRiskKey, LaundryRisk> {
        requestedFrom = from
        requestedThrough = through
        return mapOf(LaundryRiskKey("워시타워_1", "washer") to LaundryRisk.calculate(6, 1))
    }

    override fun sourceStates() = emptyList<SourceState>()
    override fun laundryVersion(sha: String): LaundryVersion? = null
    override fun observation(minuteEpoch: Long): MinuteObservation? = null
    override fun laundryEvents(since: Instant?, limit: Int) = emptyList<LaundryEvent>()
    override fun mealImage(postId: String, mediaId: String): StoredMealImage? = null
    override fun mealPosts(limit: Int) = emptyList<MealPost>()
    override fun mealPostsForMonth(from: Instant, to: Instant) = emptyList<MealPost>()
    override fun weeklyMenus(limit: Int) = emptyList<WeeklyMealMenu>()
    override fun asset(sha: String): StoredAsset? = null
    override fun recordLaundrySuccess(
        version: LaundryVersion,
        firstSeenAt: Instant,
        observation: MinuteObservation,
    ) = error("unused")
    override fun recordLaundryFailure(
        observedAt: Instant,
        observation: MinuteObservation,
        error: String,
    ) = error("unused")
    override fun recordMealCollection(
        source: String,
        sha: String,
        observedAt: Instant,
        posts: List<StoredMealPublication>,
    ) = error("unused")
    override fun recordMealFailure(source: String, observedAt: Instant, error: String) = error("unused")
}
