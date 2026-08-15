package app.junglebell.server.domain.notification

import app.junglebell.server.common.error.ApiException
import app.junglebell.server.common.config.JungleBellProperties
import app.junglebell.server.domain.security.SessionKind
import app.junglebell.server.domain.security.SessionPrincipal
import app.junglebell.server.domain.security.TokenCodec
import org.springframework.http.HttpStatus
import org.springframework.stereotype.Service
import java.time.Clock
import java.time.Duration
import java.util.UUID

@Service
class NotificationService(
    private val store: NotificationStore,
    private val tokens: TokenCodec,
    private val properties: JungleBellProperties,
    private val clock: Clock,
) {
    fun desktop(principal: SessionPrincipal, limit: Int) =
        NotificationEnvelope(store.desktopInbox(principal.userId, principal.installationId, clock.millis(), limit))

    fun mobile(principal: SessionPrincipal, limit: Int) = NotificationEnvelope(store.history(principal.userId, limit))

    fun sendTest(principal: SessionPrincipal, request: TestNotificationRequest): TestNotificationResponse {
        val now = clock.millis()
        val pushCount = store.activePushCount(principal.userId, now)
        if (principal.kind == SessionKind.MOBILE && pushCount == 0) {
            throw ApiException("PUSH_SUBSCRIPTION_REQUIRED", HttpStatus.CONFLICT)
        }
        val id = UUID.randomUUID()
        val inserted = store.create(
            NotificationRecord(
                id,
                principal.userId,
                "manual-test:${principal.sessionId}:${now / 30_000}",
                "test",
                "Jungle Bell 테스트 알림",
                "알림이 정상적으로 연결되었습니다.",
                "/#/notifications",
                mapOf("notificationId" to id.toString(), "tag" to "jungle-bell-test-${principal.sessionId}"),
                now,
                now,
                now + Duration.ofMinutes(10).toMillis(),
            ),
        )
        if (!inserted) throw ApiException("TEST_NOTIFICATION_RATE_LIMITED", HttpStatus.TOO_MANY_REQUESTS)
        if (principal.kind == SessionKind.DESKTOP && request.desktopDelivered == true) {
            store.acknowledge(principal.userId, principal.installationId, id, "displayed", now)
        }
        return TestNotificationResponse(id.toString(), pushCount)
    }

    fun acknowledge(principal: SessionPrincipal, notificationId: UUID, request: NotificationAckRequest) {
        val now = clock.millis()
        if (request.occurredAtEpochMs > now + Duration.ofMinutes(2).toMillis()) {
            throw ApiException("NOTIFICATION_ACK_TIME_INVALID")
        }
        if (!store.acknowledge(
                principal.userId,
                principal.installationId,
                notificationId,
                request.outcome,
                request.occurredAtEpochMs,
            )
        ) throw ApiException("NOTIFICATION_ACK_REJECTED", HttpStatus.CONFLICT)
    }

    fun vapidPublicKey(): String = properties.vapidPublicKey?.trim()?.takeIf(String::isNotEmpty)
        ?: throw ApiException("WEB_PUSH_NOT_CONFIGURED", HttpStatus.SERVICE_UNAVAILABLE)

    fun subscribe(principal: SessionPrincipal, request: PushSubscriptionRequest): PushSubscriptionResponse {
        vapidPublicKey()
        request.validate()
        val id = "jbps_${tokens.plainHash(request.endpoint)}"
        store.savePush(
            id,
            principal.userId,
            principal.sessionId,
            request.endpoint,
            request.keys.p256dh,
            request.keys.auth,
            clock.millis(),
        )
        return PushSubscriptionResponse(id)
    }

    fun unsubscribe(principal: SessionPrincipal, id: String) {
        if (!id.matches(Regex("^jbps_[a-f0-9]{64}$"))) throw ApiException("INVALID_REQUEST")
        if (!store.revokePush(principal.userId, id, clock.millis())) {
            throw ApiException("PUSH_SUBSCRIPTION_NOT_FOUND", HttpStatus.NOT_FOUND)
        }
    }
}
