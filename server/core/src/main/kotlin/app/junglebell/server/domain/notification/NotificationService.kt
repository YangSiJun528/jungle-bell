package app.junglebell.server.domain.notification

import app.junglebell.server.common.error.ApiException
import app.junglebell.server.common.config.JungleBellProperties
import app.junglebell.server.domain.security.SessionKind
import app.junglebell.server.domain.security.SessionPrincipal
import app.junglebell.server.domain.security.TokenCodec
import org.springframework.http.HttpStatus
import org.slf4j.LoggerFactory
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
    private val logger = LoggerFactory.getLogger(javaClass)

    fun desktop(principal: SessionPrincipal, limit: Int): NotificationEnvelope {
        logger.debug("Desktop notification lookup started. limit={}", limit)
        val response = NotificationEnvelope(
            store.desktopInbox(principal.userId, principal.installationId, clock.millis(), limit),
        )
        logger.debug("Desktop notification lookup completed. notificationCount={}", response.notifications.size)
        return response
    }

    fun mobile(principal: SessionPrincipal, limit: Int): NotificationEnvelope {
        logger.debug("Mobile notification lookup started. limit={}", limit)
        val response = NotificationEnvelope(store.history(principal.userId, limit))
        logger.debug("Mobile notification lookup completed. notificationCount={}", response.notifications.size)
        return response
    }

    fun sendTest(principal: SessionPrincipal, request: TestNotificationRequest): TestNotificationResponse {
        logger.info("Test notification creation started.")
        val now = clock.millis()
        val pushCount = store.activePushCount(principal.userId, now)
        if (principal.kind == SessionKind.MOBILE && pushCount == 0) {
            logger.warn("Test notification creation rejected. reason=push_subscription_required")
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
        if (!inserted) {
            logger.warn("Test notification creation rejected. reason=rate_limited")
            throw ApiException("TEST_NOTIFICATION_RATE_LIMITED", HttpStatus.TOO_MANY_REQUESTS)
        }
        if (principal.kind == SessionKind.DESKTOP && request.desktopDelivered == true) {
            store.acknowledge(principal.userId, principal.installationId, id, "displayed", now)
        }
        val response = TestNotificationResponse(id.toString(), pushCount)
        logger.info(
            "Test notification creation completed. notificationId={} queuedPushCount={}",
            response.notificationId,
            response.queued,
        )
        return response
    }

    fun acknowledge(principal: SessionPrincipal, notificationId: UUID, request: NotificationAckRequest) {
        logger.debug("Notification acknowledgement started. notificationId={}", notificationId)
        val now = clock.millis()
        if (request.occurredAtEpochMs > now + Duration.ofMinutes(2).toMillis()) {
            logger.warn("Notification acknowledgement rejected. reason=event_time_in_future")
            throw ApiException("NOTIFICATION_ACK_TIME_INVALID")
        }
        if (!store.acknowledge(
                principal.userId,
                principal.installationId,
                notificationId,
                request.outcome,
                request.occurredAtEpochMs,
            )
        ) {
            logger.warn("Notification acknowledgement rejected. reason=notification_not_acknowledgeable")
            throw ApiException("NOTIFICATION_ACK_REJECTED", HttpStatus.CONFLICT)
        }
        logger.debug("Notification acknowledgement completed. outcome={}", request.outcome)
    }

    fun vapidPublicKey(): String {
        logger.debug("VAPID public key lookup started.")
        val key = properties.vapidPublicKey?.trim()?.takeIf(String::isNotEmpty)
        if (key == null) {
            logger.warn("VAPID public key lookup rejected. reason=web_push_not_configured")
            throw ApiException("WEB_PUSH_NOT_CONFIGURED", HttpStatus.SERVICE_UNAVAILABLE)
        }
        logger.debug("VAPID public key lookup completed. result=configured")
        return key
    }

    fun subscribe(principal: SessionPrincipal, request: PushSubscriptionRequest): PushSubscriptionResponse {
        logger.info("Push subscription creation started.")
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
        val response = PushSubscriptionResponse(id)
        logger.info("Push subscription creation completed. subscriptionId={}", response.subscriptionId)
        return response
    }

    fun unsubscribe(principal: SessionPrincipal, id: String) {
        logger.info("Push subscription revocation started.")
        if (!id.matches(Regex("^jbps_[a-f0-9]{64}$"))) {
            logger.warn("Push subscription revocation rejected. reason=invalid_subscription_id")
            throw ApiException("INVALID_REQUEST")
        }
        if (!store.revokePush(principal.userId, id, clock.millis())) {
            logger.warn("Push subscription revocation rejected. reason=subscription_not_found")
            throw ApiException("PUSH_SUBSCRIPTION_NOT_FOUND", HttpStatus.NOT_FOUND)
        }
        logger.info("Push subscription revocation completed. subscriptionId={}", id)
    }
}
