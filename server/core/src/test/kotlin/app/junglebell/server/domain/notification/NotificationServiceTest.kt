package app.junglebell.server.domain.notification

import app.junglebell.server.common.config.JungleBellProperties
import app.junglebell.server.domain.security.SessionKind
import app.junglebell.server.domain.security.SessionPrincipal
import app.junglebell.server.domain.security.TokenCodec
import java.net.URI
import java.time.Clock
import java.time.Instant
import java.time.ZoneOffset
import java.util.UUID
import kotlin.test.Test
import kotlin.test.assertEquals

class NotificationServiceTest {
    @Test
    fun `test notification points to the root SPA notifications route`() {
        val store = CapturingNotificationStore()
        val properties = JungleBellProperties(
            URI.create("https://example.test"),
            setOf("tauri://localhost"),
            "test-pairing-secret-that-is-long-enough",
            collectors = JungleBellProperties.CollectorProperties(false, null, null, null),
        )
        val service = NotificationService(
            store,
            TokenCodec(properties),
            properties,
            Clock.fixed(Instant.parse("2026-08-14T00:00:00Z"), ZoneOffset.UTC),
        )

        service.sendTest(
            SessionPrincipal(UUID.randomUUID(), UUID.randomUUID(), "desktop-test", SessionKind.DESKTOP),
            TestNotificationRequest(),
        )

        val record = requireNotNull(store.record)
        assertEquals("/#/notifications", record.path)
        assertEquals(
            mapOf(
                "notificationId" to record.id.toString(),
                "tag" to record.payload["tag"],
                "kind" to "test",
                "title" to "Jungle Bell 테스트 알림",
                "body" to "알림이 정상적으로 연결되었습니다.",
                "path" to "/#/notifications",
                "createdAtEpochMs" to record.createdAtEpochMs,
                "expiresAtEpochMs" to record.expiresAtEpochMs,
            ),
            record.deliveryPayload(),
        )
    }

    private class CapturingNotificationStore : NotificationStore {
        var record: NotificationRecord? = null

        override fun create(record: NotificationRecord): Boolean {
            this.record = record
            return true
        }

        override fun activePushCount(userId: UUID, now: Long) = 0
        override fun createFromLaundryWatch(record: NotificationRecord, watchId: String, completeWatch: Boolean, now: Long) = error("unused")
        override fun desktopInbox(userId: UUID, installationId: String, now: Long, limit: Int) = error("unused")
        override fun history(userId: UUID, limit: Int) = error("unused")
        override fun acknowledge(userId: UUID, installationId: String, notificationId: UUID, outcome: String, occurredAt: Long) = error("unused")
        override fun savePush(id: String, userId: UUID, sessionId: UUID, endpoint: String, p256dh: String, auth: String, now: Long) = error("unused")
        override fun revokePush(userId: UUID, id: String, now: Long) = error("unused")
    }
}
