package app.junglebell.server.common.config

import jakarta.validation.Valid
import jakarta.validation.constraints.Min
import jakarta.validation.constraints.Size
import org.springframework.boot.context.properties.ConfigurationProperties
import org.springframework.validation.annotation.Validated
import java.net.URI

@Validated
@ConfigurationProperties("jungle-bell")
data class JungleBellProperties(
    val publicBaseUrl: URI,
    val allowedDesktopOrigins: Set<String>,
    @field:Size(min = 32) val pairingSecret: String,
    val vapidPublicKey: String? = null,
    val vapidPrivateKey: String? = null,
    val vapidSubject: String? = null,
    @field:Valid val collectors: CollectorProperties,
    @field:Valid val usage: UsageProperties = UsageProperties(),
) {
    data class CollectorProperties(
        val enabled: Boolean,
        val laundryUrl: URI?,
        val mealsDefaultUrl: URI?,
        val mealsPinnedUrl: URI?,
        val requestTimeoutSeconds: Long = 30,
    )

    data class UsageProperties(
        val enabled: Boolean = true,
        @field:Size(min = 32)
        val anonymousHashSecret: String = "local-development-usage-hash-secret",
        val zoneId: String = "Asia/Seoul",
        @field:Min(1) val anonymousRetentionDays: Long = 2,
        @field:Min(1) val userActivityRetentionDays: Long = 7,
        @field:Min(1) val featureRetentionDays: Long = 30,
        @field:Min(1) val summaryRetentionDays: Long = 730,
    )
}
