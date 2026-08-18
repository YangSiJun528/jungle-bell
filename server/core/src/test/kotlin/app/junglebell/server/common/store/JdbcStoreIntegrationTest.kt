package app.junglebell.server.common.store

import app.junglebell.server.domain.notification.JdbcNotificationStore
import app.junglebell.server.domain.notification.NotificationRecord
import app.junglebell.server.domain.account.JdbcAccountStore
import app.junglebell.server.domain.automation.JdbcAutomationStore
import app.junglebell.server.domain.pairing.JdbcPairingStore
import app.junglebell.server.domain.pairing.PairingRecord
import app.junglebell.server.domain.personal.AttendancePreferences
import app.junglebell.server.domain.personal.JdbcPersonalStore
import app.junglebell.server.domain.personal.MealPreferencesInput
import app.junglebell.server.domain.security.JdbcAuthStore
import app.junglebell.server.domain.security.SessionKind
import app.junglebell.server.domain.security.SessionPrincipal
import java.util.UUID
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
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
class JdbcStoreIntegrationTest {
    private lateinit var jdbc: JdbcClient

    @BeforeTest
    fun initializeSchema() {
        val dataSource = DriverManagerDataSource(postgres.jdbcUrl, postgres.username, postgres.password)
        ResourceDatabasePopulator(ClassPathResource("schema.sql")).execute(dataSource)
        jdbc = JdbcClient.create(dataSource)
    }

    @Test
    fun `personal upserts return the stored rows`() {
        val userId = createUser()
        val store = JdbcPersonalStore(jdbc)
        val attendance = AttendancePreferences(true, true, false, 8, 3, 10, 15, true, "2026-08-15")

        assertEquals(attendance, store.saveAttendance(userId, attendance, 1_000))
        assertEquals(
            app.junglebell.server.domain.personal.MealPreferences(false, true, false, 2_000),
            store.saveMeal(userId, MealPreferencesInput(false, true, false), 2_000),
        )
    }

    @Test
    fun `notification creation fans out once and reports a duplicate`() {
        val userId = createUser()
        val installationId = "desktop-${UUID.randomUUID()}"
        createDesktop(userId, installationId, randomHash(), 20_000)
        val mapper = JsonMapper.builder().addModule(KotlinModule.Builder().build()).build()
        val store = JdbcNotificationStore(jdbc, mapper)
        val notification = NotificationRecord(
            UUID.randomUUID(), userId, "event-1", "test", "title", "body", "/#/home",
            mapOf("kind" to "test"), 1_500, 1_000, 10_000,
        )

        assertTrue(store.create(notification))
        assertFalse(store.create(notification.copy(id = UUID.randomUUID())))
        assertEquals(
            1,
            jdbc.sql("SELECT count(*) FROM notification_delivery WHERE notification_id = :id")
                .param("id", notification.id).query(Int::class.java).single(),
        )
    }

    @Test
    fun `pairing approval creates the mobile session atomically`() {
        val userId = createUser()
        val desktopInstallationId = "desktop-${UUID.randomUUID()}"
        createDesktop(userId, desktopInstallationId, randomHash(), 20_000)
        val store = JdbcPairingStore(jdbc)
        val pairingId = UUID.randomUUID()
        val pairing = PairingRecord(
            pairingId, userId, desktopInstallationId, "a".repeat(64), "b".repeat(64), null,
            "pending", null, null, 1_000, 10_000, null,
        )
        store.replaceActive(pairing)
        assertTrue(store.claim(pairingId, "c".repeat(64), "mobile-1", "휴대전화"))

        assertTrue(
            store.approveAndCreateMobileSession(
                pairingId, desktopInstallationId, UUID.randomUUID(), "d".repeat(64), 2_000, 20_000,
            ),
        )
        assertEquals(
            "approved",
            jdbc.sql("SELECT status FROM pairing_challenge WHERE id = :id").param("id", pairingId)
                .query(String::class.java).single(),
        )
        assertEquals(
            "mobile",
            jdbc.sql("SELECT kind FROM app_session WHERE source_pairing_id = :id").param("id", pairingId)
                .query(String::class.java).single(),
        )
    }

    @Test
    fun `authentication returns the principal while touching the session`() {
        val userId = createUser()
        val installationId = "desktop-${UUID.randomUUID()}"
        val tokenHash = "e".repeat(64)
        createDesktop(userId, installationId, tokenHash, 20_000)

        val principal = JdbcAuthStore(jdbc).authenticateAppSession(tokenHash, 3_000)

        assertNotNull(principal)
        assertEquals(userId, principal.userId)
        assertEquals(
            3_000L,
            jdbc.sql("SELECT last_seen_at_epoch_ms FROM app_session WHERE token_sha256 = :hash")
                .param("hash", tokenHash).query(Long::class.java).single(),
        )
    }

    @Test
    fun `desktop UI replacement and session rotation return the changed rows`() {
        val userId = createUser()
        val installationId = "desktop-${UUID.randomUUID()}"
        val currentSessionId = createDesktop(userId, installationId, "f".repeat(64), 20_000)
        val principal = SessionPrincipal(currentSessionId, userId, installationId, SessionKind.DESKTOP)
        val store = JdbcAccountStore(jdbc)
        store.replaceDesktopUiSession(UUID.randomUUID(), principal, "1".repeat(64), "tauri://localhost", 1_000, 2_000)
        store.replaceDesktopUiSession(UUID.randomUUID(), principal, "2".repeat(64), "tauri://localhost", 1_100, 2_100)
        val desktopUiSession = JdbcAuthStore(jdbc).findDesktopUiSession("2".repeat(64), 1_200)
        val nextSessionId = UUID.randomUUID()

        assertNotNull(desktopUiSession)
        assertEquals(principal, desktopUiSession.principal)
        assertEquals("tauri://localhost", desktopUiSession.origin)
        assertTrue(store.rotateDesktop(principal, nextSessionId, "3".repeat(64), 1_200, 30_000))
        assertEquals(
            nextSessionId,
            jdbc.sql("SELECT id FROM app_session WHERE installation_id = :installationId AND revoked_at_epoch_ms IS NULL")
                .param("installationId", installationId).query(UUID::class.java).single(),
        )
        assertEquals(
            0,
            jdbc.sql("SELECT count(*) FROM desktop_ui_session WHERE parent_session_id = :id")
                .param("id", currentSessionId).query(Int::class.java).single(),
        )
    }

    @Test
    fun `push claim and settlement revoke a gone subscription`() {
        val userId = createUser()
        val installationId = "desktop-${UUID.randomUUID()}"
        val sessionId = createDesktop(userId, installationId, "4".repeat(64), 20_000)
        val subscriptionId = "jbps_${"5".repeat(64)}"
        jdbc.sql(
            """
            INSERT INTO push_subscription(
                id, user_id, session_id, endpoint, p256dh, auth,
                created_at_epoch_ms, revoked_at_epoch_ms
            ) VALUES (:id, :userId, :sessionId, 'https://push.example.test', 'p256dh', 'auth', 0, NULL)
            """.trimIndent(),
        ).param("id", subscriptionId).param("userId", userId).param("sessionId", sessionId).update()
        val mapper = JsonMapper.builder().addModule(KotlinModule.Builder().build()).build()
        val notificationStore = JdbcNotificationStore(jdbc, mapper)
        val record = NotificationRecord(
            UUID.randomUUID(), userId, "event-push", "test", "title", "body", "/#/home",
            emptyMap(), 1_000, 1_000, 10_000,
        )
        assertTrue(notificationStore.create(record))
        val automationStore = JdbcAutomationStore(jdbc)
        val delivery = automationStore.claimPushDeliveries(1_000, "lease-1", 10).single()

        assertTrue(automationStore.settlePush(delivery, "lease-1", "gone", 1_100, null, "expired"))
        assertEquals(
            1_100L,
            jdbc.sql("SELECT revoked_at_epoch_ms FROM push_subscription WHERE id = :id")
                .param("id", subscriptionId).query(Long::class.java).single(),
        )
    }

    private fun createUser(): UUID = UUID.randomUUID().also { userId ->
        jdbc.sql("INSERT INTO app_user(id, created_at_epoch_ms) VALUES (:id, 0)")
            .param("id", userId).update()
    }

    private fun randomHash(): String = UUID.randomUUID().toString().replace("-", "").repeat(2)

    private fun createDesktop(userId: UUID, installationId: String, tokenHash: String, expiresAt: Long): UUID {
        val sessionId = UUID.randomUUID()
        jdbc.sql(
            """
            INSERT INTO desktop_device(
                installation_id, user_id, created_at_epoch_ms, activated_at_epoch_ms,
                last_seen_at_epoch_ms, lms_session_state, app_version
            ) VALUES (:installationId, :userId, 0, 0, 0, 'unknown', NULL)
            """.trimIndent(),
        ).param("installationId", installationId).param("userId", userId).update()
        jdbc.sql(
            """
            INSERT INTO app_session(
                id, user_id, installation_id, kind, label, token_sha256,
                created_at_epoch_ms, expires_at_epoch_ms, last_seen_at_epoch_ms,
                revoked_at_epoch_ms, source_pairing_id
            ) VALUES (:id, :userId, :installationId, 'desktop', NULL, :tokenHash,
                0, :expiresAt, 0, NULL, NULL)
            """.trimIndent(),
        ).param("id", sessionId).param("userId", userId).param("installationId", installationId)
            .param("tokenHash", tokenHash).param("expiresAt", expiresAt).update()
        return sessionId
    }

    private companion object {
        @Container
        @JvmStatic
        val postgres = PostgreSQLContainer("postgres:17-alpine")
    }
}
