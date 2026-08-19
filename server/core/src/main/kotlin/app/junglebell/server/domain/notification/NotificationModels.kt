package app.junglebell.server.domain.notification

import jakarta.validation.Valid
import jakarta.validation.constraints.Max
import jakarta.validation.constraints.Min
import jakarta.validation.constraints.Pattern
import jakarta.validation.constraints.Size

data class PublicNotification(
    val id: String,
    val kind: String,
    val title: String,
    val body: String,
    val path: String,
    val createdAtEpochMs: Long,
    val expiresAtEpochMs: Long,
    val attempt: Long,
)

data class NotificationEnvelope(val notifications: List<PublicNotification>)

data class NotificationAckRequest(
    @field:Pattern(regexp = "^(displayed|failed)$") val outcome: String,
    @field:Min(0) val occurredAtEpochMs: Long,
)

internal fun canonicalNotificationKind(kind: String): String = when (kind) {
    "attendance-morning", "attendance-evening" -> "attendance-action-required"
    else -> kind
}

data class TestNotificationRequest(val desktopDelivered: Boolean? = null)
data class TestNotificationResponse(val notificationId: String, val queued: Int)

data class PushKeys(
    @field:Size(min = 40, max = 256) val p256dh: String,
    @field:Size(min = 16, max = 128) val auth: String,
)

data class PushSubscriptionRequest(
    @field:Size(min = 1, max = 2048) val endpoint: String,
    @field:Valid val keys: PushKeys,
) {
    fun validate() {
        val uri = java.net.URI.create(endpoint)
        require(uri.scheme == "https")
        require(uri.userInfo == null && uri.fragment == null)
        require(keys.p256dh.matches(Regex("^[A-Za-z0-9_-]+={0,2}$")))
        require(keys.auth.matches(Regex("^[A-Za-z0-9_-]+={0,2}$")))
    }
}

data class PushSubscriptionResponse(val subscriptionId: String)
