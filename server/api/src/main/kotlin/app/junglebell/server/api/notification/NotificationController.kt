package app.junglebell.server.api.notification

import app.junglebell.server.domain.notification.*
import app.junglebell.server.api.security.CurrentSession
import app.junglebell.server.domain.security.SessionPrincipal
import jakarta.validation.Valid
import jakarta.validation.constraints.Max
import jakarta.validation.constraints.Min
import org.springframework.http.HttpStatus
import org.slf4j.LoggerFactory
import org.springframework.validation.annotation.Validated
import org.springframework.web.bind.annotation.DeleteMapping
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.PutMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.ResponseStatus
import org.springframework.web.bind.annotation.RestController
import java.util.UUID

@Validated
@RestController
class NotificationController(private val service: NotificationService) {
    private val logger = LoggerFactory.getLogger(javaClass)

    @GetMapping("/api/desktop/notifications")
    fun desktop(
        @CurrentSession principal: SessionPrincipal,
        @RequestParam(defaultValue = "20") @Min(1) @Max(20) limit: Int,
    ): NotificationEnvelope {
        logger.debug("Desktop notification request received. limit={}", limit)
        val response = service.desktop(principal, limit)
        logger.debug("Desktop notification request completed. status=200")
        return response
    }

    @GetMapping("/api/me/notifications")
    fun accountNotifications(
        @CurrentSession principal: SessionPrincipal,
        @RequestParam(defaultValue = "20") @Min(1) @Max(20) limit: Int,
    ): NotificationEnvelope {
        logger.debug("Mobile notification request received. limit={}", limit)
        val response = service.mobile(principal, limit)
        logger.debug("Mobile notification request completed. status=200")
        return response
    }

    @PostMapping("/api/desktop/notifications/test")
    @ResponseStatus(HttpStatus.ACCEPTED)
    fun desktopTest(
        @CurrentSession principal: SessionPrincipal,
        @RequestBody request: TestNotificationRequest,
    ): TestNotificationResponse {
        logger.info("Desktop test notification request received.")
        val response = service.sendTest(principal, request)
        logger.info("Desktop test notification request completed. status=202")
        return response
    }

    @PostMapping("/api/me/notifications/test")
    @ResponseStatus(HttpStatus.ACCEPTED)
    fun mobileTest(
        @CurrentSession principal: SessionPrincipal,
        @RequestBody body: Map<String, Any?>,
    ): TestNotificationResponse {
        logger.info("Mobile test notification request received.")
        require(body.isEmpty())
        val response = service.sendTest(principal, TestNotificationRequest())
        logger.info("Mobile test notification request completed. status=202")
        return response
    }

    @PostMapping("/api/desktop/notifications/{id}/ack")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun acknowledge(
        @CurrentSession principal: SessionPrincipal,
        @PathVariable id: UUID,
        @Valid @RequestBody request: NotificationAckRequest,
    ) {
        logger.debug("Notification acknowledgement request received.")
        service.acknowledge(principal, id, request)
        logger.debug("Notification acknowledgement request completed. status=204")
    }

    @GetMapping("/api/me/push/vapid-public-key")
    fun vapidPublicKey(@CurrentSession principal: SessionPrincipal): Map<String, String> {
        logger.debug("VAPID public key request received.")
        val response = mapOf("publicKey" to service.vapidPublicKey())
        logger.debug("VAPID public key request completed. status=200")
        return response
    }

    @PutMapping("/api/me/push/subscriptions")
    @ResponseStatus(HttpStatus.CREATED)
    fun subscribe(
        @CurrentSession principal: SessionPrincipal,
        @Valid @RequestBody request: PushSubscriptionRequest,
    ): PushSubscriptionResponse {
        logger.info("Push subscription request received.")
        val response = service.subscribe(principal, request)
        logger.info("Push subscription request completed. status=201")
        return response
    }

    @DeleteMapping("/api/me/push/subscriptions/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun unsubscribe(@CurrentSession principal: SessionPrincipal, @PathVariable id: String) {
        logger.info("Push unsubscription request received.")
        service.unsubscribe(principal, id)
        logger.info("Push unsubscription request completed. status=204")
    }
}
