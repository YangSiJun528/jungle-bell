package app.junglebell.server.api.notification

import app.junglebell.server.domain.notification.*
import app.junglebell.server.api.security.CurrentSession
import app.junglebell.server.domain.security.SessionPrincipal
import jakarta.validation.Valid
import jakarta.validation.constraints.Max
import jakarta.validation.constraints.Min
import org.springframework.http.HttpStatus
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
    @GetMapping("/api/desktop/notifications")
    fun desktop(
        @CurrentSession principal: SessionPrincipal,
        @RequestParam(defaultValue = "20") @Min(1) @Max(20) limit: Int,
    ) = service.desktop(principal, limit)

    @GetMapping("/api/me/notifications")
    fun accountNotifications(
        @CurrentSession principal: SessionPrincipal,
        @RequestParam(defaultValue = "20") @Min(1) @Max(20) limit: Int,
    ) = service.mobile(principal, limit)

    @PostMapping("/api/desktop/notifications/test")
    @ResponseStatus(HttpStatus.ACCEPTED)
    fun desktopTest(
        @CurrentSession principal: SessionPrincipal,
        @RequestBody request: TestNotificationRequest,
    ) = service.sendTest(principal, request)

    @PostMapping("/api/me/notifications/test")
    @ResponseStatus(HttpStatus.ACCEPTED)
    fun mobileTest(
        @CurrentSession principal: SessionPrincipal,
        @RequestBody body: Map<String, Any?>,
    ): TestNotificationResponse {
        require(body.isEmpty())
        return service.sendTest(principal, TestNotificationRequest())
    }

    @PostMapping("/api/desktop/notifications/{id}/ack")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun acknowledge(
        @CurrentSession principal: SessionPrincipal,
        @PathVariable id: UUID,
        @Valid @RequestBody request: NotificationAckRequest,
    ) = service.acknowledge(principal, id, request)

    @GetMapping("/api/me/push/vapid-public-key")
    fun vapidPublicKey(@CurrentSession principal: SessionPrincipal) =
        mapOf("publicKey" to service.vapidPublicKey())

    @PutMapping("/api/me/push/subscriptions")
    @ResponseStatus(HttpStatus.CREATED)
    fun subscribe(
        @CurrentSession principal: SessionPrincipal,
        @Valid @RequestBody request: PushSubscriptionRequest,
    ) = service.subscribe(principal, request)

    @DeleteMapping("/api/me/push/subscriptions/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun unsubscribe(@CurrentSession principal: SessionPrincipal, @PathVariable id: String) =
        service.unsubscribe(principal, id)
}
