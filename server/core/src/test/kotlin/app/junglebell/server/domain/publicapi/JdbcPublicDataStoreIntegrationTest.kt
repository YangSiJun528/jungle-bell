package app.junglebell.server.domain.publicapi

import java.time.Instant
import java.util.UUID
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import org.springframework.core.io.ClassPathResource
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.jdbc.datasource.DriverManagerDataSource
import org.springframework.jdbc.datasource.init.ResourceDatabasePopulator
import org.testcontainers.junit.jupiter.Container
import org.testcontainers.junit.jupiter.Testcontainers
import org.testcontainers.postgresql.PostgreSQLContainer
import tools.jackson.databind.json.JsonMapper
import tools.jackson.module.kotlin.KotlinModule

@Testcontainers(disabledWithoutDocker = true)
class JdbcPublicDataStoreIntegrationTest {
    private lateinit var jdbc: JdbcClient
    private lateinit var store: JdbcPublicDataStore

    @BeforeTest
    fun initializeSchema() {
        val dataSource = DriverManagerDataSource(postgres.jdbcUrl, postgres.username, postgres.password)
        ResourceDatabasePopulator(ClassPathResource("schema.sql")).execute(dataSource)
        jdbc = JdbcClient.create(dataSource)
        val mapper = JsonMapper.builder().addModule(KotlinModule.Builder().build()).build()
        store = JdbcPublicDataStore(jdbc, mapper)
    }

    @Test
    fun `post limit never truncates the selected post images`() {
        val postId = "post-${UUID.randomUUID()}"
        val images = (0..10).map { index ->
            StoredMealImage(
                mediaId = "media-$index",
                sourceUrl = "https://example.test/$index.png",
                declaredContentType = "image/png",
                filename = "$index.png",
                width = 100,
                height = 100,
                sha = index.toString(16).padStart(64, '0'),
                contentType = "image/png",
                extension = "png",
                content = byteArrayOf(index.toByte()),
            )
        }
        val post = MealPost(
            id = postId,
            kind = "DAILY_MENU",
            contentSha = "a".repeat(64),
            title = "중식 메뉴",
            text = "메뉴",
            pinned = false,
            publishedAt = "2099-01-01T00:00:00Z",
            updatedAt = null,
            permalink = null,
            status = "published",
            images = emptyList(),
        )
        store.recordMealCollection(
            source = "meals-default",
            sha = "f".repeat(64),
            observedAt = Instant.parse("2099-01-01T00:00:00Z"),
            posts = listOf(StoredMealPublication(post, images, null)),
        )

        val stored = store.mealPosts(limit = 1).single()

        assertEquals(postId, stored.id)
        assertEquals(11, stored.images.size)
        val asset = assertNotNull(store.asset(images.last().sha))
        assertContentEquals(images.last().content, asset.bytes)
    }

    @Test
    fun `weekly menu loads its exact post outside the recent post window`() {
        val prefix = "bulk-${UUID.randomUUID()}-"
        jdbc.sql(
            """
            INSERT INTO meal_post(
                id, kind, content_sha, title, body, pinned, published_at, updated_at,
                permalink, status, first_seen_at, content_first_seen_at, last_seen_at
            )
            SELECT :prefix || value, 'OTHER', repeat('c', 64), NULL, '', false,
                   TIMESTAMPTZ '2099-02-01T00:00:00Z' + value * INTERVAL '1 minute',
                   NULL, NULL, 'published', now(), now(), now()
            FROM generate_series(1, 501) value
            """.trimIndent(),
        ).param("prefix", prefix).update()
        val targetId = "weekly-${UUID.randomUUID()}"
        val targetSha = "d".repeat(64)
        jdbc.sql(
            """
            INSERT INTO meal_post(
                id, kind, content_sha, title, body, pinned, published_at, updated_at,
                permalink, status, first_seen_at, content_first_seen_at, last_seen_at
            ) VALUES (:id, 'PINNED_MENU', :sha, '주간 메뉴', '', true,
                TIMESTAMPTZ '2000-01-01T00:00:00Z', NULL, NULL, 'published', now(), now(), now())
            """.trimIndent(),
        ).param("id", targetId).param("sha", targetSha).update()
        jdbc.sql(
            """
            INSERT INTO meal_weekly_menu(week_key, content_sha, post_id, updated_at, observed_at)
            VALUES (DATE '2099-12-28', :sha, :postId, NULL, now())
            """.trimIndent(),
        ).param("sha", targetSha).param("postId", targetId).update()

        val weekly = store.weeklyMenus(limit = 1).single()

        assertEquals(targetId, weekly.post.id)
        assertEquals(targetSha, weekly.contentSha)
    }

    @Test
    fun `laundry risk counts repeated error events once per operation session`() {
        val machineId = "risk-${UUID.randomUUID()}"
        val from = Instant.parse("2099-03-01T00:00:00Z")
        val through = Instant.parse("2099-03-08T00:00:00Z")
        val sessionOne = "session-one-${UUID.randomUUID()}"
        val sessionTwo = "session-two-${UUID.randomUUID()}"

        insertLaundryEvent(machineId, sessionOne, "STARTED", "2099-03-02T00:00:00Z")
        insertLaundryEvent(machineId, sessionOne, "ERROR_ENTERED", "2099-03-02T00:10:00Z")
        insertLaundryEvent(machineId, sessionOne, "ERROR_ENTERED", "2099-03-02T00:11:00Z")
        insertLaundryEvent(machineId, sessionTwo, "STARTED", "2099-03-03T00:00:00Z")
        insertLaundryEvent(machineId, "outside-window", "STARTED", "2099-02-28T23:59:59Z")

        val risk = assertNotNull(store.laundryRisks(from, through)[LaundryRiskKey(machineId, "washer")])

        assertEquals(2, risk.attempts)
        assertEquals(1, risk.errors)
        assertEquals(50.0, risk.rate)
        assertEquals("caution", risk.riskLevel)
    }

    private fun insertLaundryEvent(machineId: String, sessionId: String, type: String, observedAt: String) {
        jdbc.sql(
            """
            INSERT INTO laundry_event(
                id, machine_id, appliance, session_id, type, observed_at,
                current_state, detail
            ) VALUES (:id, :machineId, 'washer', :sessionId, :type, :observedAt,
                'RUNNING', '{}'::jsonb)
            """.trimIndent(),
        ).param("id", UUID.randomUUID()).param("machineId", machineId)
            .param("sessionId", sessionId).param("type", type)
            .param("observedAt", java.sql.Timestamp.from(Instant.parse(observedAt))).update()
    }

    private companion object {
        @Container
        @JvmStatic
        val postgres = PostgreSQLContainer("postgres:17-alpine")
    }
}
