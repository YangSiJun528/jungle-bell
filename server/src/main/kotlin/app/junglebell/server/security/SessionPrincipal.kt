package app.junglebell.server.security

import java.util.UUID

enum class SessionKind { DESKTOP, MOBILE }

data class SessionPrincipal(
    val sessionId: UUID,
    val userId: UUID,
    val installationId: String,
    val kind: SessionKind,
)
