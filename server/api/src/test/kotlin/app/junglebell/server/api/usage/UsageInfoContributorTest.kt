package app.junglebell.server.api.usage

import app.junglebell.server.common.config.JungleBellProperties
import app.junglebell.server.domain.usage.USAGE_AGGREGATION_SUCCESS_MARKER_NAME
import app.junglebell.server.domain.usage.UsageStore
import java.net.URI
import java.time.Clock
import java.time.Duration
import java.time.Instant
import java.time.ZoneOffset
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import org.mockito.Mockito.mock
import org.mockito.Mockito.`when`
import org.springframework.boot.actuate.info.Info
import org.springframework.dao.DataAccessResourceFailureException

class UsageInfoContributorTest {
    private val now = Instant.parse("2026-08-20T12:00:00Z")

    @Test
    fun `missing success marker reports an available database and aggregation never`() {
        assertEquals(
            mapOf(
                "configured" to true,
                "database" to "available",
                "aggregation" to "never",
            ),
            details(lastSuccess = null),
        )
    }

    @Test
    fun `success marker stays fresh through the worker schedule grace period`() {
        val completedAt = now.minus(Duration.ofMinutes(130))

        assertEquals(
            mapOf(
                "configured" to false,
                "database" to "available",
                "aggregation" to "fresh",
                "lastSuccessfulAggregationAt" to completedAt.toString(),
            ),
            details(lastSuccess = completedAt.toEpochMilli(), enabled = false),
        )
    }

    @Test
    fun `success marker older than the grace period reports stale`() {
        val completedAt = now.minus(Duration.ofMinutes(130)).minusMillis(1)

        assertEquals(
            mapOf(
                "configured" to true,
                "database" to "available",
                "aggregation" to "stale",
                "lastSuccessfulAggregationAt" to completedAt.toString(),
            ),
            details(lastSuccess = completedAt.toEpochMilli()),
        )
    }

    @Test
    fun `database query failure reports unavailable without exposing internal data`() {
        val store = mock(UsageStore::class.java)
        `when`(store.lastAggregationSuccess(USAGE_AGGREGATION_SUCCESS_MARKER_NAME))
            .thenThrow(DataAccessResourceFailureException("database offline"))

        assertEquals(
            mapOf(
                "configured" to true,
                "database" to "unavailable",
                "aggregation" to "unavailable",
            ),
            contribute(store),
        )
    }

    private fun details(lastSuccess: Long?, enabled: Boolean = true): Map<*, *> {
        val store = mock(UsageStore::class.java)
        `when`(store.lastAggregationSuccess(USAGE_AGGREGATION_SUCCESS_MARKER_NAME)).thenReturn(lastSuccess)
        return contribute(store, enabled)
    }

    private fun contribute(store: UsageStore, enabled: Boolean = true): Map<*, *> {
        val builder = Info.Builder()
        UsageInfoContributor(
            store,
            properties(enabled),
            Clock.fixed(now, ZoneOffset.UTC),
        ).contribute(builder)
        return assertIs<Map<*, *>>(builder.build()["usageMetrics"])
    }

    private fun properties(enabled: Boolean) = JungleBellProperties(
        publicBaseUrl = URI("https://example.test"),
        allowedDesktopOrigins = emptySet(),
        pairingSecret = "p".repeat(32),
        collectors = JungleBellProperties.CollectorProperties(false, null, null, null),
        usage = JungleBellProperties.UsageProperties(
            enabled = enabled,
            anonymousHashSecret = "s".repeat(32),
        ),
    )
}
