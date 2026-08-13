package app.junglebell.server.security

import app.junglebell.server.common.ApiException
import org.springframework.http.HttpStatus
import java.util.UUID

enum class SessionKind { DESKTOP, MOBILE }

data class SessionPrincipal(
    val sessionId: UUID,
    val userId: UUID,
    val installationId: String,
    val kind: SessionKind,
)

fun SessionPrincipal.requireDesktop(): SessionPrincipal {
    if (kind != SessionKind.DESKTOP) {
        throw ApiException("DESKTOP_CAPABILITY_REQUIRED", HttpStatus.FORBIDDEN)
    }
    return this
}
