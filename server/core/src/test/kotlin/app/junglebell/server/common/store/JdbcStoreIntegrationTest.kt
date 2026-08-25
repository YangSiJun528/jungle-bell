package app.junglebell.server.common.store

import app.junglebell.server.domain.notification.JdbcNotificationStore
import app.junglebell.server.domain.notification.NotificationRecord
import app.junglebell.server.domain.account.JdbcAccountStore
import app.junglebell.server.domain.automation.JdbcAutomationStore
import app.junglebell.server.domain.pairing.JdbcPairingStore
import app.junglebell.server.domain.pairing.PairingRecord
import app.junglebell.server.domain.personal.AttendancePreferences
import app.junglebell.server.domain.personal.JdbcPersonalStore
import app.junglebell.server.domain.personal.LaundryWatch
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
    fun `desktop enrollment enables usage collection for a new account`() {
        val userId = UUID.randomUUID()
        JdbcAccountStore(jdbc).enrollDesktop(
            rateLimits = emptyList(),
            rateWindowMs = 60_000,
            userId = userId,
            installationId = "desktop-new-account",
            usageAnalyticsEnabled = true,
            sessionId = UUID.randomUUID(),
            tokenHash = randomHash(),
            now = 1_000,
            expiresAt = 2_000,
        )

        assertTrue(
            jdbc.sql("SELECT enabled FROM usage_preference WHERE user_id = :userId")
                .param("userId", userId).query(Boolean::class.java).single(),
        )
    }

    @Test
    fun `laundry notification mode is shared by personal and automation stores`() {
        val userId = createUser()
        val watch = LaundryWatch(
            id = "jbw_${"a".repeat(64)}",
            machineId = "워시타워_1",
            appliance = "washer",
            sessionId = "session-1",
            notificationMode = "estimated-completion",
            notifyBeforeMinutes = 0,
            status = "active",
            createdAtEpochMs = 1_000,
            updatedAtEpochMs = 1_000,
        )

        val personalStore = JdbcPersonalStore(jdbc)
        assertTrue(personalStore.createWatch(userId, watch))
        assertEquals(listOf(watch), personalStore.watches(userId))
        assertEquals(
            "estimated-completion",
            JdbcAutomationStore(jdbc).activeLaundryWatches()
                .single { it.id == watch.id }.notificationMode,
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
        assertEquals(0L, store.desktopInbox(userId, installationId, 1_500, 20).single().attempt)
        assertEquals(
            listOf(notification.id.toString(), "title", "body", "/#/home", "10000"),
            jdbc.sql(
                """
                SELECT payload ->> 'notificationId', payload ->> 'title', payload ->> 'body',
                       payload ->> 'path', payload ->> 'expiresAtEpochMs'
                FROM notification WHERE id = :id
                """.trimIndent(),
            ).param("id", notification.id).query { row, _ ->
                (1..5).map(row::getString)
            }.single(),
        )
    }

    @Test
    fun `laundry attention is deduplicated and tracks unresolved state`() {
        val userId = createUser()
        val watch = LaundryWatch(
            id = "jbw_${"b".repeat(64)}",
            machineId = "워시타워_1",
            appliance = "dryer",
            sessionId = "dryer-session-1",
            notificationMode = "confirmed-completion",
            notifyBeforeMinutes = 0,
            status = "active",
            createdAtEpochMs = 1_000,
            updatedAtEpochMs = 1_000,
        )
        assertTrue(JdbcPersonalStore(jdbc).createWatch(userId, watch))
        val mapper = JsonMapper.builder().addModule(KotlinModule.Builder().build()).build()
        val notifications = JdbcNotificationStore(jdbc, mapper)
        val automation = JdbcAutomationStore(jdbc)
        val sessionId = checkNotNull(watch.sessionId)

        insertLaundryEvent(watch.machineId, watch.appliance, sessionId, "ERROR_ENTERED", 500)
        assertEquals(null, automation.activeLaundryWatches().single { it.id == watch.id }.pendingAttentionStatus)
        insertLaundryEvent(watch.machineId, watch.appliance, "different-session", "ERROR_ENTERED", 1_200)
        assertEquals(null, automation.activeLaundryWatches().single { it.id == watch.id }.pendingAttentionStatus)
        insertLaundryEvent(watch.machineId, watch.appliance, sessionId, "STOPPED_UNEXPECTEDLY", 1_500)
        assertEquals(null, automation.activeLaundryWatches().single { it.id == watch.id }.pendingAttentionStatus)
        val firstIncidentId = insertLaundryEvent(
            watch.machineId,
            watch.appliance,
            sessionId,
            "ERROR_ENTERED",
            2_000,
        )
        var lifecycle = automation.activeLaundryWatches().single { it.id == watch.id }
        assertEquals("ERROR", lifecycle.pendingAttentionStatus)
        assertEquals(firstIncidentId.toString(), lifecycle.pendingAttentionIncidentId)
        assertFalse(lifecycle.attentionRecovered)
        insertLaundryEvent(watch.machineId, watch.appliance, sessionId, "PAUSED", 2_500)
        assertEquals("ERROR", automation.activeLaundryWatches().single { it.id == watch.id }.pendingAttentionStatus)
        insertLaundryEvent(watch.machineId, watch.appliance, sessionId, "STARTED", 3_000)
        lifecycle = automation.activeLaundryWatches().single { it.id == watch.id }
        assertEquals(null, lifecycle.pendingAttentionStatus)
        assertEquals(null, lifecycle.pendingAttentionIncidentId)
        assertFalse(lifecycle.attentionRecovered)
        val alertedIncidentId = insertLaundryEvent(
            watch.machineId,
            watch.appliance,
            sessionId,
            "PAUSED",
            4_000,
        )
        lifecycle = automation.activeLaundryWatches().single { it.id == watch.id }
        assertEquals("PAUSED", lifecycle.pendingAttentionStatus)
        assertEquals(alertedIncidentId.toString(), lifecycle.pendingAttentionIncidentId)
        assertFalse(lifecycle.attentionRecovered)

        val attention = NotificationRecord(
            UUID.randomUUID(), userId,
            "laundry-attention:${watch.id}:${watch.sessionId}:$alertedIncidentId",
            "laundry-attention", "건조기가 멈췄습니다", "상태를 확인해 주세요.", "/#/laundry",
            emptyMap(), 5_000, 5_000, 20_000,
        )

        assertTrue(notifications.createFromLaundryWatch(attention, watch.id, completeWatch = false, now = 5_000))
        lifecycle = automation.activeLaundryWatches().single { it.id == watch.id }
        assertTrue(lifecycle.attentionUnresolved)
        assertEquals(5_000L, lifecycle.attentionUnresolvedAtEpochMs)
        assertFalse(lifecycle.attentionRecovered)
        assertFalse(
            notifications.createFromLaundryWatch(
                attention.copy(id = UUID.randomUUID()),
                watch.id,
                completeWatch = false,
                now = 6_000,
            ),
        )
        assertEquals(
            1,
            jdbc.sql("SELECT count(*) FROM notification WHERE user_id = :userId AND source_event_id = :sourceEventId")
                .param("userId", userId).param("sourceEventId", attention.sourceEventId)
                .query(Int::class.java).single(),
        )

        insertLaundryEvent(watch.machineId, watch.appliance, sessionId, "STARTED", 7_000)
        lifecycle = automation.activeLaundryWatches().single { it.id == watch.id }
        assertTrue(lifecycle.attentionUnresolved)
        assertTrue(lifecycle.attentionRecovered)
        assertTrue(automation.markLaundryWatchResumed(watch.id, 7_000))
        assertFalse(automation.activeLaundryWatches().single { it.id == watch.id }.attentionUnresolved)
        assertEquals(null, automation.activeLaundryWatches().single { it.id == watch.id }.pendingAttentionStatus)
        val nextIncidentId = insertLaundryEvent(
            watch.machineId,
            watch.appliance,
            sessionId,
            "ERROR_ENTERED",
            8_000,
        )
        val nextAttention = attention.copy(
            id = UUID.randomUUID(),
            sourceEventId = "laundry-attention:${watch.id}:${watch.sessionId}:$nextIncidentId",
        )
        assertTrue(
            notifications.createFromLaundryWatch(
                nextAttention,
                watch.id,
                completeWatch = false,
                now = 9_000,
            ),
        )
        val repeatedIncident = automation.activeLaundryWatches().single { it.id == watch.id }
        assertTrue(repeatedIncident.attentionUnresolved)
        assertEquals("ERROR", repeatedIncident.pendingAttentionStatus)
        assertEquals(nextIncidentId.toString(), repeatedIncident.pendingAttentionIncidentId)
        assertEquals(9_000L, repeatedIncident.attentionUnresolvedAtEpochMs)
        assertEquals(
            2,
            jdbc.sql("SELECT count(*) FROM notification WHERE user_id = :userId AND kind = 'laundry-attention'")
                .param("userId", userId).query(Int::class.java).single(),
        )

        assertTrue(automation.completeLaundryWatch(watch.id, 10_000))
        assertEquals("completed", JdbcPersonalStore(jdbc).watches(userId).single { it.id == watch.id }.status)
        assertFalse(
            notifications.createFromLaundryWatch(
                attention.copy(id = UUID.randomUUID(), sourceEventId = "attention-after-completion"),
                watch.id,
                completeWatch = false,
                now = 11_000,
            ),
        )
    }

    @Test
    fun `duplicate terminal notification still completes an active laundry watch`() {
        val userId = createUser()
        val watch = LaundryWatch(
            id = "jbw_${"c".repeat(64)}",
            machineId = "워시타워_2",
            appliance = "dryer",
            sessionId = "dryer-session-2",
            notificationMode = "estimated-completion",
            notifyBeforeMinutes = 0,
            status = "active",
            createdAtEpochMs = 1_000,
            updatedAtEpochMs = 1_000,
        )
        assertTrue(JdbcPersonalStore(jdbc).createWatch(userId, watch))
        val mapper = JsonMapper.builder().addModule(KotlinModule.Builder().build()).build()
        val notifications = JdbcNotificationStore(jdbc, mapper)
        val expected = NotificationRecord(
            UUID.randomUUID(), userId, "laundry-completion-expected:${watch.id}:${watch.sessionId}:estimated-completion",
            "laundry-completion-expected", "건조 완료 예상", "상태를 확인해 주세요.", "/#/laundry",
            emptyMap(), 2_000, 2_000, 20_000,
        )

        assertTrue(notifications.createFromLaundryWatch(expected, watch.id, completeWatch = false, now = 2_000))
        assertEquals("active", JdbcPersonalStore(jdbc).watches(userId).single { it.id == watch.id }.status)
        assertFalse(
            notifications.createFromLaundryWatch(
                expected.copy(id = UUID.randomUUID()),
                watch.id,
                completeWatch = true,
                now = 3_000,
            ),
        )
        assertEquals("completed", JdbcPersonalStore(jdbc).watches(userId).single { it.id == watch.id }.status)
    }

    @Test
    fun `legacy attendance notification kinds are normalized when read`() {
        val userId = createUser()
        val mapper = JsonMapper.builder().addModule(KotlinModule.Builder().build()).build()
        val store = JdbcNotificationStore(jdbc, mapper)
        val notification = NotificationRecord(
            UUID.randomUUID(), userId, "legacy-attendance", "test", "title", "body", "/#/attendance",
            emptyMap(), 1_500, 1_000, 10_000,
        )
        assertTrue(store.create(notification))
        jdbc.sql("UPDATE notification SET kind = 'attendance-evening' WHERE id = :id")
            .param("id", notification.id).update()

        assertEquals("attendance-action-required", store.history(userId, 20).single().kind)
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
        createDesktop(userId, installationId, tokenHash, 200_000)

        val store = JdbcAuthStore(jdbc)
        val principal = store.authenticateAppSession(tokenHash, 70_000)

        assertNotNull(principal)
        assertEquals(userId, principal.userId)
        assertEquals(
            70_000L,
            jdbc.sql("SELECT last_seen_at_epoch_ms FROM app_session WHERE token_sha256 = :hash")
                .param("hash", tokenHash).query(Long::class.java).single(),
        )
        assertNotNull(store.authenticateAppSession(tokenHash, 100_000))
        assertEquals(
            70_000L,
            jdbc.sql("SELECT last_seen_at_epoch_ms FROM app_session WHERE token_sha256 = :hash")
                .param("hash", tokenHash).query(Long::class.java).single(),
        )
        assertNotNull(store.authenticateAppSession(tokenHash, 131_000))
        assertEquals(
            131_000L,
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
    fun `desktop identity deletion cascades every account-owned session and subscription`() {
        val userId = createUser()
        val installationId = "desktop-${UUID.randomUUID()}"
        val desktopSessionId = createDesktop(userId, installationId, randomHash(), 20_000)
        val mobileSessionId = UUID.randomUUID()
        jdbc.sql(
            """
            INSERT INTO app_session(
                id, user_id, installation_id, kind, label, token_sha256,
                created_at_epoch_ms, expires_at_epoch_ms, last_seen_at_epoch_ms,
                revoked_at_epoch_ms, source_pairing_id
            ) VALUES (:id, :userId, 'mobile-reset-test', 'mobile', '휴대전화', :tokenHash,
                0, 20000, 0, NULL, NULL)
            """.trimIndent(),
        ).param("id", mobileSessionId).param("userId", userId).param("tokenHash", randomHash()).update()
        jdbc.sql(
            """
            INSERT INTO push_subscription(
                id, user_id, session_id, endpoint, p256dh, auth,
                created_at_epoch_ms, revoked_at_epoch_ms
            ) VALUES (:id, :userId, :sessionId, 'https://push.example.test/reset', 'p256dh', 'auth', 0, NULL)
            """.trimIndent(),
        ).param("id", "jbps_${randomHash()}").param("userId", userId)
            .param("sessionId", mobileSessionId).update()
        jdbc.sql(
            "INSERT INTO usage_preference(user_id, enabled, updated_at_epoch_ms) VALUES (:userId, true, 0)",
        ).param("userId", userId).update()
        val principal = SessionPrincipal(desktopSessionId, userId, installationId, SessionKind.DESKTOP)

        assertTrue(JdbcAccountStore(jdbc).deleteDesktopIdentity(principal))
        for (table in listOf("app_user", "desktop_device", "app_session", "push_subscription", "usage_preference")) {
            assertEquals(
                0,
                jdbc.sql("SELECT count(*) FROM $table WHERE ${if (table == "app_user") "id" else "user_id"} = :userId")
                    .param("userId", userId).query(Int::class.java).single(),
                table,
            )
        }
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

    @Test
    fun `inactive push delivery is settled once without leasing`() {
        val userId = createUser()
        val installationId = "desktop-${UUID.randomUUID()}"
        val sessionId = createDesktop(userId, installationId, randomHash(), 20_000)
        val subscriptionId = "jbps_${randomHash()}"
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
        val notification = NotificationRecord(
            UUID.randomUUID(), userId, "event-inactive-push", "test", "title", "body", "/#/home",
            emptyMap(), 1_000, 1_000, 10_000,
        )
        assertTrue(notificationStore.create(notification))
        jdbc.sql("UPDATE push_subscription SET revoked_at_epoch_ms = 500 WHERE id = :id")
            .param("id", subscriptionId).update()
        val automationStore = JdbcAutomationStore(jdbc)

        assertTrue(automationStore.claimPushDeliveries(1_000, "lease-inactive-1", 10).isEmpty())
        assertTrue(automationStore.claimPushDeliveries(2_000, "lease-inactive-2", 10).isEmpty())
        assertEquals(
            "gone",
            jdbc.sql(
                "SELECT status FROM notification_delivery WHERE notification_id = :id AND target_id = :targetId",
            ).param("id", notification.id).param("targetId", subscriptionId).query(String::class.java).single(),
        )
        assertEquals(
            0,
            jdbc.sql(
                "SELECT attempts FROM notification_delivery WHERE notification_id = :id AND target_id = :targetId",
            ).param("id", notification.id).param("targetId", subscriptionId).query(Int::class.java).single(),
        )
    }

    private fun createUser(): UUID = UUID.randomUUID().also { userId ->
        jdbc.sql("INSERT INTO app_user(id, created_at_epoch_ms) VALUES (:id, 0)")
            .param("id", userId).update()
    }

    private fun randomHash(): String = UUID.randomUUID().toString().replace("-", "").repeat(2)

    private fun insertLaundryEvent(
        machineId: String,
        appliance: String,
        sessionId: String,
        type: String,
        observedAtEpochMs: Long,
    ): UUID {
        val id = UUID.randomUUID()
        val currentState = when (type) {
            "ERROR_ENTERED" -> "ERROR"
            "PAUSED" -> "PAUSE"
            "COMPLETED" -> "END"
            "STOPPED_UNEXPECTEDLY" -> "POWER_OFF"
            else -> "RUNNING"
        }
        jdbc.sql(
            """
            INSERT INTO laundry_event(
                id, machine_id, appliance, session_id, type, observed_at,
                current_state, detail
            ) VALUES (:id, :machineId, :appliance, :sessionId, :type, :observedAt,
                :currentState, '{}'::jsonb)
            """.trimIndent(),
        ).param("id", id).param("machineId", machineId).param("appliance", appliance)
            .param("sessionId", sessionId).param("type", type)
            .param("observedAt", java.sql.Timestamp.from(java.time.Instant.ofEpochMilli(observedAtEpochMs)))
            .param("currentState", currentState).update()
        return id
    }

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
