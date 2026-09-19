package app.junglebell.server.domain.publicapi

import app.junglebell.server.common.config.JungleBellProperties
import org.mockito.Mockito.mock
import org.mockito.Mockito.`when`
import java.net.URI
import java.time.Clock
import java.time.Instant
import java.time.ZoneOffset
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class PublicDataServiceLaundryFreshnessTest {
    private val now = Instant.parse("2026-09-20T00:10:00Z")

    @Test
    fun `active source changed less than five minutes ago is not overdue`() {
        for (age in listOf(0L, 60L, 61L, 120L, 240L, 299L, 300L)) {
            val quality = snapshot(age).quality
            assertTrue(quality.collectorHealthy)
            assertEquals(
                if (age <= 60) "REFRESH_OBSERVED" else "WITHIN_REFRESH_WINDOW",
                quality.sourceFreshness,
                "source change age: $age seconds",
            )
        }
    }

    @Test
    fun `recent collection does not hide unchanged active source older than six minutes`() {
        assertEquals("UNVERIFIABLE_STABLE", snapshot(360).quality.sourceFreshness)
        val quality = snapshot(361).quality
        assertTrue(quality.collectorHealthy)
        assertEquals(now.toString(), quality.lastCheckedAt)
        assertEquals("REFRESH_OVERDUE", quality.sourceFreshness)
    }

    @Test
    fun `collection gaps and failed attempts remain stale even when source change is recent`() {
        assertEquals("WITHIN_REFRESH_WINDOW", snapshot(240, collectionAge = 120).quality.sourceFreshness)
        for (quality in listOf(snapshot(240, collectionAge = 121).quality, snapshot(30, failures = 1).quality)) {
            assertFalse(quality.collectorHealthy)
            assertEquals("COLLECTION_GAP", quality.sourceFreshness)
            assertEquals("STALE", quality.collection)
        }
    }

    @Test
    fun `unchanged idle source is stable without claiming a new source refresh`() {
        assertEquals("UNVERIFIABLE_STABLE", snapshot(3_600, active = false).quality.sourceFreshness)
    }

    private fun snapshot(
        sourceAge: Long,
        collectionAge: Long = 0,
        failures: Int = 0,
        active: Boolean = true,
    ): PublicLaundrySnapshot {
        val store = mock(PublicDataStore::class.java)
        val observedAt = now.minusSeconds(sourceAge)
        val checkedAt = now.minusSeconds(collectionAge).toString()
        val appliance = LaundryAppliance(
            machineId = "워시타워_1",
            appliance = "washer",
            observedAt = observedAt.toString(),
            state = NormalizedEnum(if (active) "RUNNING" else "POWER_OFF", null, true),
            operationalStatus = if (active) "RUNNING" else "IDLE",
            remainingMinutes = if (active) 20 else 0,
            totalMinutes = 60,
            startedAt = observedAt.toString(),
            estimatedFinishAt = if (active) observedAt.plusSeconds(1_200).toString() else null,
            remoteControlEnabled = null,
            cycleCount = null,
            sessionId = null,
            errorCode = null,
        )
        `when`(store.latestLaundryVersion()).thenReturn(
            LaundryVersion(
                sourceVersionSha = "a".repeat(64),
                observedAt = observedAt.toString(),
                machines = listOf(LaundryMachine("워시타워_1", appliance, null)),
                events = emptyList(),
                unknownEnums = emptyList(),
            ),
        )
        `when`(store.sourceState("laundry")).thenReturn(
            SourceState("laundry", now.toString(), checkedAt, "a".repeat(64), observedAt.toString(), failures, null),
        )
        return PublicDataService(
            store,
            Clock.fixed(now, ZoneOffset.UTC),
            JungleBellProperties(
                URI("https://example.test"), emptySet(), "x".repeat(32),
                collectors = JungleBellProperties.CollectorProperties(false, null, null, null),
            ),
        ).laundry()
    }
}
