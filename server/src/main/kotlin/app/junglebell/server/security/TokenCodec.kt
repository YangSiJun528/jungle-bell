package app.junglebell.server.security

import app.junglebell.server.config.JungleBellProperties
import org.springframework.stereotype.Component
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

@Component
class TokenCodec(properties: JungleBellProperties) {
    private val random = SecureRandom()
    private val pairingKey = properties.pairingSecret.toByteArray(StandardCharsets.UTF_8)

    fun opaque(prefix: String, byteLength: Int = 32): String =
        prefix + ByteArray(byteLength).also(random::nextBytes).toHex()

    fun sessionHash(token: String): String = sha256("jungle-bell:app-session:v3\u0000$token")
    fun uiSessionHash(token: String): String = sha256("jungle-bell:desktop-ui:v1\u0000$token")
    fun plainHash(value: String): String = sha256(value)
    fun manualCodeHash(value: String): String = hmac(value)

    fun mobileToken(claimReceipt: String): String =
        "jbs_" + hmac("jungle-bell:mobile-session:v3\u0000$claimReceipt")

    fun manualCode(): String {
        val alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
        return buildString(10) {
            repeat(10) { append(alphabet[random.nextInt(alphabet.length)]) }
        }
    }

    fun normalizeManualCode(value: String): String? {
        val normalized = value.uppercase()
            .replace(Regex("[\\s-]"), "")
            .replace('I', '1')
            .replace('L', '1')
            .replace('O', '0')
        val alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
        return normalized.takeIf { it.length == 10 && it.all(alphabet::contains) }
    }

    private fun sha256(value: String): String =
        MessageDigest.getInstance("SHA-256")
            .digest(value.toByteArray(StandardCharsets.UTF_8))
            .toHex()

    private fun hmac(value: String): String {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(pairingKey, "HmacSHA256"))
        return mac.doFinal(value.toByteArray(StandardCharsets.UTF_8)).toHex()
    }

    private fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it) }
}
