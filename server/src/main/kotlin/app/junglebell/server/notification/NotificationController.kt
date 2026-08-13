package app.junglebell.server.notification

import app.junglebell.server.security.SessionPrincipal
import jakarta.validation.Valid
import jakarta.validation.constraints.Max
import jakarta.validation.constraints.Min
import org.springframework.http.HttpStatus
import org.springframework.security.core.annotation.AuthenticationPrincipal
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
        @AuthenticationPrincipal principal: SessionPrincipal,
        @RequestParam(defaultValue = "20") @Min(1) @Max(20) limit: Int,
    ) = service.desktop(principal, limit)

    @GetMapping("/api/mobile/notifications")
    fun mobile(
        @AuthenticationPrincipal principal: SessionPrincipal,
        @RequestParam(defaultValue = "20") @Min(1) @Max(20) limit: Int,
    ) = service.mobile(principal, limit)

    @PostMapping("/api/desktop/notifications/test")
    @ResponseStatus(HttpStatus.ACCEPTED)
    fun desktopTest(
        @AuthenticationPrincipal principal: SessionPrincipal,
        @RequestBody request: TestNotificationRequest,
    ) = service.sendTest(principal, request)

    @PostMapping("/api/mobile/notifications/test")
    @ResponseStatus(HttpStatus.ACCEPTED)
    fun mobileTest(
        @AuthenticationPrincipal principal: SessionPrincipal,
        @RequestBody body: Map<String, Any?>,
    ): TestNotificationResponse {
        require(body.isEmpty())
        return service.sendTest(principal, TestNotificationRequest())
    }

    @PostMapping("/api/desktop/notifications/{id}/ack")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun acknowledge(
        @AuthenticationPrincipal principal: SessionPrincipal,
        @PathVariable id: UUID,
        @Valid @RequestBody request: NotificationAckRequest,
    ) = service.acknowledge(principal, id, request)

    @GetMapping("/api/push/vapid-public-key")
    fun vapidPublicKey(@AuthenticationPrincipal principal: SessionPrincipal) =
        mapOf("publicKey" to service.vapidPublicKey())

    @PutMapping("/api/push/subscriptions")
    @ResponseStatus(HttpStatus.CREATED)
    fun subscribe(
        @AuthenticationPrincipal principal: SessionPrincipal,
        @Valid @RequestBody request: PushSubscriptionRequest,
    ) = service.subscribe(principal, request)

    @DeleteMapping("/api/push/subscriptions/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun unsubscribe(@AuthenticationPrincipal principal: SessionPrincipal, @PathVariable id: String) =
        service.unsubscribe(principal, id)
}
