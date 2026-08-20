package app.junglebell.server.domain.usage

import app.junglebell.server.common.config.JungleBellProperties
import app.junglebell.server.domain.security.SessionKind
import app.junglebell.server.domain.security.SessionPrincipal
import java.time.Clock
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset
import java.net.URI
import java.util.UUID
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class UsageRecorderTest {
    private val instant = Instant.parse("2026-08-20T01:00:00Z")
    private val clock = Clock.fixed(instant, ZoneOffset.UTC)

    @Test
    fun `authenticated usage derives the client from the trusted session`() {
        val store = RecordingUsageStore()
        val recorder = UsageRecorder(store, properties(), clock)
        val desktop = principal(SessionKind.DESKTOP)
        val mobile = principal(SessionKind.MOBILE)

        recorder.recordUiOpened(desktop)
        recorder.recordFeature(mobile, UsageFeature.LAUNDRY_WATCH_CREATED)

        assertEquals(
            UserActivity(LocalDate.of(2026, 8, 20), desktop.userId, UsageClient.DESKTOP),
            store.userActivities.single(),
        )
        assertEquals(
            FeatureActivity(LocalDate.of(2026, 8, 20), mobile.userId, UsageClient.PWA),
            store.features.single(),
        )
    }

    @Test
    fun `disabled or failed metrics never affect the caller`() {
        val disabledStore = RecordingUsageStore()
        UsageRecorder(disabledStore, properties(enabled = false), clock)
            .recordUiOpened(principal(SessionKind.DESKTOP))
        assertTrue(disabledStore.userActivities.isEmpty())

        val failedStore = RecordingUsageStore(fail = true)
        UsageRecorder(failedStore, properties(), clock)
            .recordFeature(principal(SessionKind.DESKTOP), UsageFeature.MOBILE_DEVICE_PAIRED)
        assertTrue(failedStore.features.isEmpty())
    }

    @Test
    fun `anonymous visitor token is never stored and invalid tokens are replaced`() {
        val store = RecordingUsageStore()
        val recorder = AnonymousUsageRecorder(store, properties(), clock)

        val issued = assertNotNull(recorder.recordUiOpened(null, UsageClient.WEB))
        val reused = assertNotNull(recorder.recordUiOpened(issued.token, UsageClient.PWA))
        val replaced = assertNotNull(recorder.recordUiOpened("invalid", UsageClient.WEB))

        assertTrue(issued.newToken)
        assertFalse(reused.newToken)
        assertTrue(replaced.newToken)
        assertEquals(issued.token, reused.token)
        assertNotEquals(issued.token, replaced.token)
        assertTrue(store.anonymousActivities.all { it.visitorHash.matches(Regex("^[0-9a-f]{64}$")) })
        assertTrue(store.anonymousActivities.none { it.visitorHash == issued.token })
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

    private fun principal(kind: SessionKind) = SessionPrincipal(
        sessionId = UUID.randomUUID(),
        userId = UUID.randomUUID(),
        installationId = "installation",
        kind = kind,
    )

    private data class UserActivity(val date: LocalDate, val userId: UUID, val client: UsageClient)
    private data class FeatureActivity(val date: LocalDate, val userId: UUID, val client: UsageClient)
    private data class AnonymousActivity(val visitorHash: String)

    private class RecordingUsageStore(private val fail: Boolean = false) : UsageStore {
        val userActivities = mutableListOf<UserActivity>()
        val features = mutableListOf<FeatureActivity>()
        val anonymousActivities = mutableListOf<AnonymousActivity>()

        override fun tryAcquireAggregationLease(name: String, now: Long, durationMs: Long, token: String) = true

        override fun recordUserActivity(
            date: LocalDate,
            userId: UUID,
            client: UsageClient,
            activity: UsageActivity,
        ): Boolean {
            if (fail) error("database unavailable")
            userActivities += UserActivity(date, userId, client)
            return true
        }

        override fun incrementFeature(
            date: LocalDate,
            userId: UUID,
            client: UsageClient,
            feature: UsageFeature,
        ): Long {
            if (fail) error("database unavailable")
            features += FeatureActivity(date, userId, client)
            return 1
        }

        override fun recordAnonymousActivity(
            date: LocalDate,
            visitorHash: String,
            client: UsageClient,
            activity: UsageActivity,
        ): Boolean {
            if (fail) error("database unavailable")
            anonymousActivities += AnonymousActivity(visitorHash)
            return true
        }

        override fun rebuildSummary(date: LocalDate, calculatedAtEpochMs: Long) = Unit
        override fun rawDatesOnOrAfter(date: LocalDate): Set<LocalDate> = emptySet()
        override fun purge(
            anonymousBefore: LocalDate,
            userActivityBefore: LocalDate,
            featureBefore: LocalDate,
            summaryBefore: LocalDate,
        ) = UsagePurgeResult(0, 0, 0, 0)
    }
}
