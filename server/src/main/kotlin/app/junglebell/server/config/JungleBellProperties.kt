package app.junglebell.server.config

import jakarta.validation.Valid
import jakarta.validation.constraints.NotBlank
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
) {
    data class CollectorProperties(
        val enabled: Boolean,
        val laundryUrl: URI?,
        val mealsDefaultUrl: URI?,
        val mealsPinnedUrl: URI?,
        val requestTimeoutSeconds: Long = 30,
    )
}
