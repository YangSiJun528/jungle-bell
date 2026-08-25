package app.junglebell.server.domain.usage

import java.time.LocalDate
import java.util.UUID
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import org.springframework.core.io.ClassPathResource
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.jdbc.datasource.DriverManagerDataSource
import org.springframework.jdbc.datasource.init.ResourceDatabasePopulator
import org.testcontainers.junit.jupiter.Container
import org.testcontainers.junit.jupiter.Testcontainers
import org.testcontainers.postgresql.PostgreSQLContainer

@Testcontainers(disabledWithoutDocker = true)
class JdbcUsageStoreIntegrationTest {
    private lateinit var jdbc: JdbcClient
    private lateinit var store: JdbcUsageStore

    @BeforeTest
    fun initializeSchema() {
        val dataSource = DriverManagerDataSource(postgres.jdbcUrl, postgres.username, postgres.password)
        ResourceDatabasePopulator(ClassPathResource("schema.sql")).execute(dataSource)
        jdbc = JdbcClient.create(dataSource)
        store = JdbcUsageStore(jdbc)
    }

    @Test
    fun `aggregation lease prevents another worker from running within the lease window`() {
        assertTrue(store.tryAcquireAggregationLease("usage-summary", 10_000, 3_000, "first"))
        assertFalse(store.tryAcquireAggregationLease("usage-summary", 12_000, 3_000, "second"))
        assertTrue(store.tryAcquireAggregationLease("usage-summary", 13_001, 3_000, "third"))
    }

    @Test
    fun `daily user activity is idempotent while feature usage increments atomically`() {
        val day = LocalDate.of(2026, 8, 20)
        val userId = createUser()

        assertTrue(store.recordUserActivity(day, userId, UsageClient.DESKTOP, UsageActivity.UI_OPENED))
        assertFalse(store.recordUserActivity(day, userId, UsageClient.DESKTOP, UsageActivity.UI_OPENED))
        assertEquals(1L, store.incrementFeature(day, userId, UsageClient.DESKTOP, UsageFeature.LAUNDRY_WATCH_CREATED))
        assertEquals(2L, store.incrementFeature(day, userId, UsageClient.DESKTOP, UsageFeature.LAUNDRY_WATCH_CREATED))
    }

    @Test
    fun `existing account preference is undecided until explicitly stored`() {
        val userId = createUser(usageEnabled = null)
        val day = LocalDate.of(2026, 8, 20)

        assertEquals(UsagePreference(null), store.usagePreference(userId))
        assertFalse(store.recordUserActivity(day, userId, UsageClient.DESKTOP, UsageActivity.UI_OPENED))
        assertEquals(
            0L,
            store.incrementFeature(day, userId, UsageClient.DESKTOP, UsageFeature.LAUNDRY_WATCH_CREATED),
        )
        assertEquals(UsagePreference(true), store.putUsagePreference(userId, true, 1_000))
        assertEquals(UsagePreference(true), store.usagePreference(userId))
        assertEquals(UsagePreference(false), store.putUsagePreference(userId, false, 2_000))
        assertEquals(UsagePreference(false), store.usagePreference(userId))
        assertFalse(store.recordUserActivity(day, userId, UsageClient.PWA, UsageActivity.UI_OPENED))
    }

    @Test
    fun `summary keeps per-client counts and deduplicates the same user across clients`() {
        val day = LocalDate.of(2026, 8, 20)
        val first = createUser()
        val second = createUser()
        store.recordUserActivity(day, first, UsageClient.DESKTOP, UsageActivity.UI_OPENED)
        store.recordUserActivity(day, first, UsageClient.PWA, UsageActivity.UI_OPENED)
        store.recordUserActivity(day, second, UsageClient.PWA, UsageActivity.UI_OPENED)
        store.incrementFeature(day, first, UsageClient.DESKTOP, UsageFeature.ATTENDANCE_SETTINGS_CHANGED)
        store.incrementFeature(day, first, UsageClient.PWA, UsageFeature.ATTENDANCE_SETTINGS_CHANGED)
        store.incrementFeature(day, first, UsageClient.PWA, UsageFeature.ATTENDANCE_SETTINGS_CHANGED)
        store.recordAnonymousActivity(day, "a".repeat(64), UsageClient.WEB, UsageActivity.UI_OPENED)
        store.recordAnonymousActivity(day, "b".repeat(64), UsageClient.WEB, UsageActivity.UI_OPENED)

        store.rebuildSummary(day, 10_000, UsageSummaryScope.entries.toSet())

        assertSummary(day, "authenticated", "activity", "desktop", "ui_opened", 1, 1)
        assertSummary(day, "authenticated", "activity", "pwa", "ui_opened", 2, 2)
        assertSummary(day, "authenticated", "activity", "all", "ui_opened", 2, 3)
        assertSummary(day, "authenticated", "feature", "all", "attendance_settings_changed", 1, 3)
        assertSummary(day, "anonymous", "activity", "all", "ui_opened", 2, 2)

        store.rebuildSummary(day, 20_000, UsageSummaryScope.entries.toSet())
        assertEquals(
            8,
            jdbc.sql("SELECT count(*) FROM usage_daily_summary WHERE usage_date = :day")
                .param("day", day).query(Int::class.java).single(),
        )

        jdbc.sql("DELETE FROM app_user WHERE id IN (:first, :second)")
            .param("first", first).param("second", second).update()
        store.rebuildSummary(day, 30_000, UsageSummaryScope.entries.toSet())
        assertEquals(
            2,
            jdbc.sql("SELECT count(*) FROM usage_daily_summary WHERE usage_date = :day")
                .param("day", day).query(Int::class.java).single(),
        )
    }

    @Test
    fun `feature-only rebuild preserves activity summaries after their raw retention expires`() {
        val day = LocalDate.of(2026, 7, 22)
        val userId = createUser()
        store.recordUserActivity(day, userId, UsageClient.DESKTOP, UsageActivity.UI_OPENED)
        store.incrementFeature(day, userId, UsageClient.DESKTOP, UsageFeature.LAUNDRY_WATCH_CREATED)
        store.recordAnonymousActivity(day, "e".repeat(64), UsageClient.WEB, UsageActivity.UI_OPENED)
        store.rebuildSummary(day, 1_000, UsageSummaryScope.entries.toSet())

        store.purge(
            anonymousBefore = day.plusDays(1),
            userActivityBefore = day.plusDays(1),
            featureBefore = day,
            summaryBefore = day.minusYears(1),
        )
        store.rebuildSummary(day, 2_000, setOf(UsageSummaryScope.AUTHENTICATED_FEATURE))

        assertSummary(day, "authenticated", "activity", "all", "ui_opened", 1, 1)
        assertSummary(day, "anonymous", "activity", "all", "ui_opened", 1, 1)
        assertSummary(day, "authenticated", "feature", "all", "laundry_watch_created", 1, 1)
    }

    @Test
    fun `purge applies separate raw and summary retention cutoffs`() {
        val oldDay = LocalDate.of(2026, 7, 1)
        val recentDay = LocalDate.of(2026, 8, 19)
        val userId = createUser()
        store.recordUserActivity(oldDay, userId, UsageClient.DESKTOP, UsageActivity.UI_OPENED)
        store.recordUserActivity(recentDay, userId, UsageClient.DESKTOP, UsageActivity.UI_OPENED)
        store.incrementFeature(oldDay, userId, UsageClient.DESKTOP, UsageFeature.MOBILE_DEVICE_PAIRED)
        store.incrementFeature(recentDay, userId, UsageClient.DESKTOP, UsageFeature.MOBILE_DEVICE_PAIRED)
        store.recordAnonymousActivity(oldDay, "c".repeat(64), UsageClient.WEB, UsageActivity.UI_OPENED)
        store.recordAnonymousActivity(recentDay, "d".repeat(64), UsageClient.WEB, UsageActivity.UI_OPENED)
        store.rebuildSummary(oldDay, 1_000, UsageSummaryScope.entries.toSet())
        store.rebuildSummary(recentDay, 2_000, UsageSummaryScope.entries.toSet())

        val result = store.purge(
            anonymousBefore = LocalDate.of(2026, 8, 18),
            userActivityBefore = LocalDate.of(2026, 8, 14),
            featureBefore = LocalDate.of(2026, 7, 21),
            summaryBefore = LocalDate.of(2025, 1, 1),
        )

        assertEquals(1, result.anonymousRows)
        assertEquals(1, result.userActivityRows)
        assertEquals(1, result.featureRows)
        assertEquals(0, result.summaryRows)
        assertEquals(1, jdbc.sql("SELECT count(*) FROM usage_user_day").query(Int::class.java).single())
        assertEquals(1, jdbc.sql("SELECT count(*) FROM usage_feature_day").query(Int::class.java).single())
        assertEquals(1, jdbc.sql("SELECT count(*) FROM usage_anonymous_day").query(Int::class.java).single())
    }

    private fun assertSummary(
        day: LocalDate,
        audience: String,
        kind: String,
        client: String,
        code: String,
        uniqueSubjects: Long,
        totalCount: Long,
    ) {
        val actual = jdbc.sql(
            """
            SELECT unique_subjects, total_count
            FROM usage_daily_summary
            WHERE usage_date = :day AND audience = :audience AND metric_kind = :kind
              AND client = :client AND metric_code = :code
            """.trimIndent(),
        ).param("day", day).param("audience", audience).param("kind", kind)
            .param("client", client).param("code", code)
            .query { row, _ -> row.getLong("unique_subjects") to row.getLong("total_count") }
            .single()
        assertEquals(uniqueSubjects to totalCount, actual)
    }

    private fun createUser(usageEnabled: Boolean? = true): UUID = UUID.randomUUID().also { id ->
        jdbc.sql("INSERT INTO app_user(id, created_at_epoch_ms) VALUES (:id, 0)")
            .param("id", id).update()
        if (usageEnabled != null) {
            jdbc.sql(
                "INSERT INTO usage_preference(user_id, enabled, updated_at_epoch_ms) VALUES (:id, :enabled, 0)",
            ).param("id", id).param("enabled", usageEnabled).update()
        }
    }

    private companion object {
        @Container
        val postgres = PostgreSQLContainer("postgres:17-alpine")
    }
}
