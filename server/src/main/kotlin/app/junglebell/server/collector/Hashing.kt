package app.junglebell.server.collector

import java.nio.charset.StandardCharsets
import java.security.MessageDigest

internal fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256")
    .digest(bytes).joinToString("") { "%02x".format(it) }

internal fun sha256(value: String): String = sha256(value.toByteArray(StandardCharsets.UTF_8))
