package app.junglebell.server.domain.usage

import app.junglebell.server.common.config.JungleBellProperties
import app.junglebell.server.domain.security.SessionKind
import app.junglebell.server.domain.security.SessionPrincipal
import java.net.URI
import java.time.Clock
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset
import java.util.UUID
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import org.springframework.dao.DataAccessResourceFailureException
import org.springframework.dao.DataIntegrityViolationException
import org.springframework.dao.RecoverableDataAccessException
import org.springframework.dao.TransientDataAccessResourceException

class UsageRecorderTest {
    private val instant = Instant.parse("2026-08-20T01:00:00Z")
    private val clock = Clock.fixed(instant, ZoneOffset.UTC)

    @Test
    fun `authenticated usage derives the client from the trusted session`() {
        val store = RecordingUsageStore()
        val recorder = UsageRecorder(store, properties(), clock)
        val desktop = principal(SessionKind.DESKTOP)
        val mobile = principal(SessionKind.MOBILE)

        assertEquals(UsageRecordingOutcome.RECORDED, recorder.recordUiOpened(desktop))
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
    fun `disabled UI metrics are skipped and feature failures remain best effort`() {
        val disabledStore = RecordingUsageStore()
        val outcome = UsageRecorder(disabledStore, properties(enabled = false), clock)
            .recordUiOpened(principal(SessionKind.DESKTOP))
        assertEquals(UsageRecordingOutcome.SKIPPED, outcome)
        assertTrue(disabledStore.userActivities.isEmpty())

        val failedStore = RecordingUsageStore(featureFailure = IllegalStateException("database unavailable"))
        UsageRecorder(failedStore, properties(), clock)
            .recordFeature(principal(SessionKind.DESKTOP), UsageFeature.MOBILE_DEVICE_PAIRED)
        assertTrue(failedStore.features.isEmpty())

        val preferenceFailedStore = RecordingUsageStore(
            preferenceFailure = IllegalStateException("preference unavailable"),
        )
        UsageRecorder(preferenceFailedStore, properties(), clock)
            .recordFeature(principal(SessionKind.DESKTOP), UsageFeature.MOBILE_DEVICE_PAIRED)
        assertTrue(preferenceFailedStore.features.isEmpty())
    }

    @Test
    fun `undecided or opted out accounts do not record authenticated usage`() {
        val undecided = RecordingUsageStore(preferenceEnabled = null)
        val undecidedOutcome = UsageRecorder(undecided, properties(), clock)
            .recordUiOpened(principal(SessionKind.DESKTOP))
        assertEquals(UsageRecordingOutcome.SKIPPED, undecidedOutcome)
        assertTrue(undecided.userActivities.isEmpty())

        val disabled = RecordingUsageStore(preferenceEnabled = false)
        UsageRecorder(disabled, properties(), clock)
            .recordFeature(principal(SessionKind.MOBILE), UsageFeature.LAUNDRY_WATCH_CREATED)
        assertTrue(disabled.features.isEmpty())
    }

    @Test
    fun `authenticated UI open distinguishes inserts from deduplicated records`() {
        val principal = principal(SessionKind.DESKTOP)
        val recorded = UsageRecorder(RecordingUsageStore(), properties(), clock)
            .recordUiOpened(principal)
        val noChange = UsageRecorder(
            RecordingUsageStore(userActivityRecorded = false),
            properties(),
            clock,
        ).recordUiOpened(principal)

        assertEquals(UsageRecordingOutcome.RECORDED, recorded)
        assertEquals(UsageRecordingOutcome.NO_CHANGE, noChange)
    }

    @Test
    fun `retryable data access failures report UI collection unavailable`() {
        val failures = listOf(
            TransientDataAccessResourceException("transient"),
            RecoverableDataAccessException("recoverable"),
            DataAccessResourceFailureException("resource unavailable"),
        )

        failures.forEach { failure ->
            val outcome = UsageRecorder(
                RecordingUsageStore(userActivityFailure = failure),
                properties(),
                clock,
            ).recordUiOpened(principal(SessionKind.DESKTOP))

            assertEquals(UsageRecordingOutcome.UNAVAILABLE, outcome)
        }

        val preferenceOutcome = UsageRecorder(
            RecordingUsageStore(
                preferenceFailure = TransientDataAccessResourceException("preference unavailable"),
            ),
            properties(),
            clock,
        ).recordUiOpened(principal(SessionKind.DESKTOP))
        assertEquals(UsageRecordingOutcome.UNAVAILABLE, preferenceOutcome)
    }

    @Test
    fun `unexpected UI collection failures propagate`() {
        val nonRetryable = UsageRecorder(
            RecordingUsageStore(userActivityFailure = DataIntegrityViolationException("invalid data")),
            properties(),
            clock,
        )
        val codingFailure = UsageRecorder(
            RecordingUsageStore(userActivityFailure = IllegalStateException("unexpected")),
            properties(),
            clock,
        )

        assertFailsWith<DataIntegrityViolationException> {
            nonRetryable.recordUiOpened(principal(SessionKind.DESKTOP))
        }
        assertFailsWith<IllegalStateException> {
            codingFailure.recordUiOpened(principal(SessionKind.DESKTOP))
        }
    }

    @Test
    fun `anonymous visitor token is never stored and invalid tokens are replaced`() {
        val store = RecordingUsageStore()
        val recorder = AnonymousUsageRecorder(store, properties(), clock)

        val issued = assertNotNull(recorder.recordUiOpened(null, UsageClient.WEB).identity)
        val reused = assertNotNull(recorder.recordUiOpened(issued.token, UsageClient.PWA).identity)
        val replaced = assertNotNull(recorder.recordUiOpened("invalid", UsageClient.WEB).identity)

        assertTrue(issued.newToken)
        assertFalse(reused.newToken)
        assertTrue(replaced.newToken)
        assertEquals(issued.token, reused.token)
        assertNotEquals(issued.token, replaced.token)
        assertTrue(store.anonymousActivities.all { it.visitorHash.matches(Regex("^[0-9a-f]{64}$")) })
        assertTrue(store.anonymousActivities.none { it.visitorHash == issued.token })
    }

    @Test
    fun `anonymous UI open distinguishes disabled and deduplicated records`() {
        val disabledStore = RecordingUsageStore()
        val disabled = AnonymousUsageRecorder(disabledStore, properties(enabled = false), clock)
            .recordUiOpened(null, UsageClient.WEB)
        val noChange = AnonymousUsageRecorder(
            RecordingUsageStore(anonymousActivityRecorded = false),
            properties(),
            clock,
        ).recordUiOpened(null, UsageClient.WEB)

        assertEquals(UsageRecordingOutcome.SKIPPED, disabled.outcome)
        assertEquals(null, disabled.identity)
        assertTrue(disabledStore.anonymousActivities.isEmpty())
        assertEquals(UsageRecordingOutcome.NO_CHANGE, noChange.outcome)
    }

    @Test
    fun `anonymous retryable failure preserves its identity for retry`() {
        val recorder = AnonymousUsageRecorder(
            RecordingUsageStore(
                anonymousActivityFailure = TransientDataAccessResourceException("unavailable"),
            ),
            properties(),
            clock,
        )

        val recording = recorder.recordUiOpened(null, UsageClient.WEB)

        assertEquals(UsageRecordingOutcome.UNAVAILABLE, recording.outcome)
        assertTrue(assertNotNull(recording.identity).newToken)
    }

    @Test
    fun `anonymous unexpected data failure propagates`() {
        val recorder = AnonymousUsageRecorder(
            RecordingUsageStore(
                anonymousActivityFailure = DataIntegrityViolationException("invalid data"),
            ),
            properties(),
            clock,
        )

        assertFailsWith<DataIntegrityViolationException> {
            recorder.recordUiOpened(null, UsageClient.WEB)
        }
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

    private class RecordingUsageStore(
        private val userActivityFailure: RuntimeException? = null,
        private val anonymousActivityFailure: RuntimeException? = null,
        private val featureFailure: RuntimeException? = null,
        private val preferenceFailure: RuntimeException? = null,
        private var preferenceEnabled: Boolean? = true,
        private val userActivityRecorded: Boolean = true,
        private val anonymousActivityRecorded: Boolean = true,
    ) : UsageStore {
        val userActivities = mutableListOf<UserActivity>()
        val features = mutableListOf<FeatureActivity>()
        val anonymousActivities = mutableListOf<AnonymousActivity>()

        override fun tryAcquireAggregationLease(name: String, now: Long, durationMs: Long, token: String) = true
        override fun markAggregationSuccess(name: String, completedAtEpochMs: Long) = Unit
        override fun lastAggregationSuccess(name: String): Long? = null

        override fun usagePreference(userId: UUID): UsagePreference {
            preferenceFailure?.let { throw it }
            return UsagePreference(preferenceEnabled)
        }

        override fun putUsagePreference(userId: UUID, enabled: Boolean, now: Long): UsagePreference {
            preferenceEnabled = enabled
            return UsagePreference(enabled)
        }

        override fun recordUserActivity(
            date: LocalDate,
            userId: UUID,
            client: UsageClient,
            activity: UsageActivity,
        ): Boolean {
            userActivityFailure?.let { throw it }
            userActivities += UserActivity(date, userId, client)
            return userActivityRecorded
        }

        override fun incrementFeature(
            date: LocalDate,
            userId: UUID,
            client: UsageClient,
            feature: UsageFeature,
        ): Long {
            featureFailure?.let { throw it }
            features += FeatureActivity(date, userId, client)
            return 1
        }

        override fun recordAnonymousActivity(
            date: LocalDate,
            visitorHash: String,
            client: UsageClient,
            activity: UsageActivity,
        ): Boolean {
            anonymousActivityFailure?.let { throw it }
            anonymousActivities += AnonymousActivity(visitorHash)
            return anonymousActivityRecorded
        }

        override fun rebuildSummary(
            date: LocalDate,
            calculatedAtEpochMs: Long,
            scopes: Set<UsageSummaryScope>,
        ) = Unit
        override fun rawDatesOnOrAfter(date: LocalDate): Set<LocalDate> = emptySet()
        override fun purge(
            anonymousBefore: LocalDate,
            userActivityBefore: LocalDate,
            featureBefore: LocalDate,
            summaryBefore: LocalDate,
        ) = UsagePurgeResult(0, 0, 0, 0)
    }
}
