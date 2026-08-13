package app.junglebell.server.security

import app.junglebell.server.common.ApiException
import app.junglebell.server.config.JungleBellProperties
import org.springframework.http.HttpStatus
import org.springframework.stereotype.Service
import java.time.Clock

@Service
class AuthService(
    private val repository: AuthRepository,
    private val tokens: TokenCodec,
    private val properties: JungleBellProperties,
    private val clock: Clock,
) {
    fun desktop(token: String): SessionPrincipal = appSession(token, SessionKind.DESKTOP)
    fun mobile(token: String): SessionPrincipal = appSession(token, SessionKind.MOBILE)

    fun desktopUi(token: String, origin: String?): SessionPrincipal {
        if (origin == null || origin !in properties.allowedDesktopOrigins) {
            throw ApiException("ORIGIN_NOT_ALLOWED", HttpStatus.FORBIDDEN)
        }
        if (!token.matches(Regex("^jbui_[a-f0-9]{64}$"))) {
            throw ApiException("AUTHENTICATION_REQUIRED", HttpStatus.UNAUTHORIZED)
        }
        return repository.findDesktopUiSession(tokens.uiSessionHash(token), origin, clock.millis())
            ?: throw ApiException("AUTHENTICATION_REQUIRED", HttpStatus.UNAUTHORIZED)
    }

    private fun appSession(token: String, expectedKind: SessionKind): SessionPrincipal {
        if (!token.matches(Regex("^jb[ds]_[a-f0-9]{64}$"))) {
            throw ApiException("AUTHENTICATION_REQUIRED", HttpStatus.UNAUTHORIZED)
        }
        val principal = repository.findAppSession(tokens.sessionHash(token), clock.millis())
            ?: throw ApiException("AUTHENTICATION_REQUIRED", HttpStatus.UNAUTHORIZED)
        if (principal.kind != expectedKind) {
            throw ApiException("SESSION_KIND_DENIED", HttpStatus.FORBIDDEN)
        }
        repository.touch(principal.sessionId, clock.millis())
        return principal
    }
}
