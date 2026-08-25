package app.junglebell.server.domain.usage

import java.time.LocalDate
import java.util.UUID
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.stereotype.Repository
import org.springframework.transaction.annotation.Transactional

@Repository
class JdbcUsageStore(private val jdbc: JdbcClient) : UsageStore {
    override fun tryAcquireAggregationLease(name: String, now: Long, durationMs: Long, token: String): Boolean =
        jdbc.sql(
            """
            INSERT INTO maintenance_state(name, last_run_at_epoch_ms, run_token)
            VALUES (:name, :now, :token)
            ON CONFLICT (name) DO UPDATE
            SET last_run_at_epoch_ms = EXCLUDED.last_run_at_epoch_ms,
                run_token = EXCLUDED.run_token
            WHERE maintenance_state.last_run_at_epoch_ms <= :expiresBefore
            RETURNING run_token
            """.trimIndent(),
        ).param("name", name).param("now", now).param("token", token)
            .param("expiresBefore", now - durationMs).query(String::class.java).optional().isPresent

    override fun usagePreference(userId: UUID): UsagePreference = UsagePreference(
        jdbc.sql("SELECT enabled FROM usage_preference WHERE user_id = :userId")
            .param("userId", userId).query(Boolean::class.java).optional().orElse(null),
    )

    override fun putUsagePreference(userId: UUID, enabled: Boolean, now: Long): UsagePreference {
        val stored = jdbc.sql(
            """
            INSERT INTO usage_preference(user_id, enabled, updated_at_epoch_ms)
            SELECT id, :enabled, :now FROM app_user WHERE id = :userId
            ON CONFLICT (user_id) DO UPDATE SET
                enabled = EXCLUDED.enabled,
                updated_at_epoch_ms = EXCLUDED.updated_at_epoch_ms
            RETURNING enabled
            """.trimIndent(),
        ).param("userId", userId).param("enabled", enabled).param("now", now)
            .query(Boolean::class.java).single()
        return UsagePreference(stored)
    }

    override fun recordUserActivity(
        date: LocalDate,
        userId: UUID,
        client: UsageClient,
        activity: UsageActivity,
    ): Boolean = jdbc.sql(
        """
        INSERT INTO usage_user_day(usage_date, user_id, client, activity)
        SELECT :date, preference.user_id, :client, :activity
        FROM usage_preference preference
        WHERE preference.user_id = :userId AND preference.enabled
        ON CONFLICT DO NOTHING
        RETURNING user_id
        """.trimIndent(),
    ).param("date", date).param("userId", userId).param("client", client.value)
        .param("activity", activity.value).query(UUID::class.java).optional().isPresent

    override fun recordAnonymousActivity(
        date: LocalDate,
        visitorHash: String,
        client: UsageClient,
        activity: UsageActivity,
    ): Boolean {
        require(client != UsageClient.DESKTOP)
        require(visitorHash.matches(HASH_PATTERN))
        return jdbc.sql(
            """
            INSERT INTO usage_anonymous_day(usage_date, visitor_hash, client, activity)
            VALUES (:date, :visitorHash, :client, :activity)
            ON CONFLICT DO NOTHING
            RETURNING visitor_hash
            """.trimIndent(),
        ).param("date", date).param("visitorHash", visitorHash).param("client", client.value)
            .param("activity", activity.value).query(String::class.java).optional().isPresent
    }

    override fun incrementFeature(
        date: LocalDate,
        userId: UUID,
        client: UsageClient,
        feature: UsageFeature,
    ): Long = jdbc.sql(
        """
        INSERT INTO usage_feature_day(usage_date, user_id, client, feature_code, use_count)
        SELECT :date, preference.user_id, :client, :feature, 1
        FROM usage_preference preference
        WHERE preference.user_id = :userId AND preference.enabled
        ON CONFLICT (usage_date, user_id, client, feature_code)
        DO UPDATE SET use_count = usage_feature_day.use_count + 1
        RETURNING use_count
        """.trimIndent(),
    ).param("date", date).param("userId", userId).param("client", client.value)
        .param("feature", feature.value).query(Long::class.java).optional().orElse(0L)

    @Transactional
    override fun rebuildSummary(
        date: LocalDate,
        calculatedAtEpochMs: Long,
        scopes: Set<UsageSummaryScope>,
    ) {
        if (UsageSummaryScope.AUTHENTICATED_ACTIVITY in scopes) {
            insertAuthenticatedActivities(date, calculatedAtEpochMs, byClient = true)
            insertAuthenticatedActivities(date, calculatedAtEpochMs, byClient = false)
        }
        if (UsageSummaryScope.AUTHENTICATED_FEATURE in scopes) {
            insertFeatures(date, calculatedAtEpochMs, byClient = true)
            insertFeatures(date, calculatedAtEpochMs, byClient = false)
        }
        if (UsageSummaryScope.ANONYMOUS_ACTIVITY in scopes) {
            insertAnonymousActivities(date, calculatedAtEpochMs, byClient = true)
            insertAnonymousActivities(date, calculatedAtEpochMs, byClient = false)
        }
        deleteStaleSummaryRows(date, scopes)
    }

    override fun rawDatesOnOrAfter(date: LocalDate): Set<LocalDate> = jdbc.sql(
        """
        SELECT usage_date FROM usage_user_day WHERE usage_date >= :date
        UNION
        SELECT usage_date FROM usage_feature_day WHERE usage_date >= :date
        UNION
        SELECT usage_date FROM usage_anonymous_day WHERE usage_date >= :date
        ORDER BY usage_date
        """.trimIndent(),
    ).param("date", date).query(LocalDate::class.java).list().filterNotNull().toSet()

    @Transactional
    override fun purge(
        anonymousBefore: LocalDate,
        userActivityBefore: LocalDate,
        featureBefore: LocalDate,
        summaryBefore: LocalDate,
    ): UsagePurgeResult = UsagePurgeResult(
        anonymousRows = deleteBefore("usage_anonymous_day", anonymousBefore),
        userActivityRows = deleteBefore("usage_user_day", userActivityBefore),
        featureRows = deleteBefore("usage_feature_day", featureBefore),
        summaryRows = deleteBefore("usage_daily_summary", summaryBefore),
    )

    private fun insertAuthenticatedActivities(date: LocalDate, calculatedAt: Long, byClient: Boolean) {
        val client = if (byClient) "client" else "'all'"
        val clientGroup = if (byClient) ", client" else ""
        jdbc.sql(
            """
            INSERT INTO usage_daily_summary(
                usage_date, audience, metric_kind, client, metric_code,
                unique_subjects, total_count, calculated_at_epoch_ms
            )
            SELECT usage_date, 'authenticated', 'activity', $client, activity,
                   COUNT(DISTINCT user_id), COUNT(*), :calculatedAt
            FROM usage_user_day
            WHERE usage_date = :date
            GROUP BY usage_date, activity$clientGroup
            ON CONFLICT (usage_date, audience, metric_kind, client, metric_code)
            DO UPDATE SET unique_subjects = EXCLUDED.unique_subjects,
                          total_count = EXCLUDED.total_count,
                          calculated_at_epoch_ms = EXCLUDED.calculated_at_epoch_ms
            """.trimIndent(),
        ).param("date", date).param("calculatedAt", calculatedAt).update()
    }

    private fun insertFeatures(date: LocalDate, calculatedAt: Long, byClient: Boolean) {
        val client = if (byClient) "client" else "'all'"
        val clientGroup = if (byClient) ", client" else ""
        jdbc.sql(
            """
            INSERT INTO usage_daily_summary(
                usage_date, audience, metric_kind, client, metric_code,
                unique_subjects, total_count, calculated_at_epoch_ms
            )
            SELECT usage_date, 'authenticated', 'feature', $client, feature_code,
                   COUNT(DISTINCT user_id), SUM(use_count), :calculatedAt
            FROM usage_feature_day
            WHERE usage_date = :date
            GROUP BY usage_date, feature_code$clientGroup
            ON CONFLICT (usage_date, audience, metric_kind, client, metric_code)
            DO UPDATE SET unique_subjects = EXCLUDED.unique_subjects,
                          total_count = EXCLUDED.total_count,
                          calculated_at_epoch_ms = EXCLUDED.calculated_at_epoch_ms
            """.trimIndent(),
        ).param("date", date).param("calculatedAt", calculatedAt).update()
    }

    private fun insertAnonymousActivities(date: LocalDate, calculatedAt: Long, byClient: Boolean) {
        val client = if (byClient) "client" else "'all'"
        val clientGroup = if (byClient) ", client" else ""
        jdbc.sql(
            """
            INSERT INTO usage_daily_summary(
                usage_date, audience, metric_kind, client, metric_code,
                unique_subjects, total_count, calculated_at_epoch_ms
            )
            SELECT usage_date, 'anonymous', 'activity', $client, activity,
                   COUNT(DISTINCT visitor_hash), COUNT(*), :calculatedAt
            FROM usage_anonymous_day
            WHERE usage_date = :date
            GROUP BY usage_date, activity$clientGroup
            ON CONFLICT (usage_date, audience, metric_kind, client, metric_code)
            DO UPDATE SET unique_subjects = EXCLUDED.unique_subjects,
                          total_count = EXCLUDED.total_count,
                          calculated_at_epoch_ms = EXCLUDED.calculated_at_epoch_ms
            """.trimIndent(),
        ).param("date", date).param("calculatedAt", calculatedAt).update()
    }

    private fun deleteStaleSummaryRows(date: LocalDate, scopes: Set<UsageSummaryScope>) {
        jdbc.sql(
            """
            DELETE FROM usage_daily_summary summary
            WHERE summary.usage_date = :date
              AND (
                (:authenticatedActivity
                  AND summary.audience = 'authenticated' AND summary.metric_kind = 'activity')
                OR (:authenticatedFeature
                  AND summary.audience = 'authenticated' AND summary.metric_kind = 'feature')
                OR (:anonymousActivity
                  AND summary.audience = 'anonymous' AND summary.metric_kind = 'activity')
              )
              AND NOT (
                (summary.audience = 'authenticated' AND summary.metric_kind = 'activity' AND EXISTS (
                    SELECT 1 FROM usage_user_day raw
                    WHERE raw.usage_date = summary.usage_date
                      AND raw.activity = summary.metric_code
                      AND (summary.client = 'all' OR raw.client = summary.client)
                )) OR
                (summary.audience = 'authenticated' AND summary.metric_kind = 'feature' AND EXISTS (
                    SELECT 1 FROM usage_feature_day raw
                    WHERE raw.usage_date = summary.usage_date
                      AND raw.feature_code = summary.metric_code
                      AND (summary.client = 'all' OR raw.client = summary.client)
                )) OR
                (summary.audience = 'anonymous' AND summary.metric_kind = 'activity' AND EXISTS (
                    SELECT 1 FROM usage_anonymous_day raw
                    WHERE raw.usage_date = summary.usage_date
                      AND raw.activity = summary.metric_code
                      AND (summary.client = 'all' OR raw.client = summary.client)
                ))
              )
            """.trimIndent(),
        ).param("date", date)
            .param("authenticatedActivity", UsageSummaryScope.AUTHENTICATED_ACTIVITY in scopes)
            .param("authenticatedFeature", UsageSummaryScope.AUTHENTICATED_FEATURE in scopes)
            .param("anonymousActivity", UsageSummaryScope.ANONYMOUS_ACTIVITY in scopes)
            .update()
    }

    private fun deleteBefore(table: String, cutoff: LocalDate): Int {
        require(table in TABLES)
        return jdbc.sql("DELETE FROM $table WHERE usage_date < :cutoff")
            .param("cutoff", cutoff).update()
    }

    private companion object {
        val HASH_PATTERN = Regex("^[0-9a-f]{64}$")
        val TABLES = setOf(
            "usage_anonymous_day",
            "usage_user_day",
            "usage_feature_day",
            "usage_daily_summary",
        )
    }
}
