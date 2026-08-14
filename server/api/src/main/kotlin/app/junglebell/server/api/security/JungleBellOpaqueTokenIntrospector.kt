package app.junglebell.server.api.security

import app.junglebell.server.domain.security.AuthStore
import app.junglebell.server.domain.security.SessionKind
import app.junglebell.server.domain.security.SessionPrincipal
import app.junglebell.server.domain.security.TokenCodec
import java.time.Clock
import org.springframework.security.core.authority.SimpleGrantedAuthority
import org.springframework.security.oauth2.core.DefaultOAuth2AuthenticatedPrincipal
import org.springframework.security.oauth2.core.OAuth2AuthenticatedPrincipal
import org.springframework.security.oauth2.server.resource.introspection.BadOpaqueTokenException
import org.springframework.security.oauth2.server.resource.introspection.OpaqueTokenIntrospector
import org.springframework.stereotype.Component

@Component
class JungleBellOpaqueTokenIntrospector(
    private val store: AuthStore,
    private val tokens: TokenCodec,
    private val clock: Clock,
) : OpaqueTokenIntrospector {
    override fun introspect(token: String): OAuth2AuthenticatedPrincipal {
        val now = clock.millis()
        val principal = when {
            DESKTOP_TOKEN.matches(token) -> store.authenticateAppSession(tokens.sessionHash(token), now)
                ?.takeIf { it.kind == SessionKind.DESKTOP }
                ?.let { principal(it, null, DESKTOP_AUTHORITY) }

            MOBILE_TOKEN.matches(token) -> store.authenticateAppSession(tokens.sessionHash(token), now)
                ?.takeIf { it.kind == SessionKind.MOBILE }
                ?.let { principal(it, null, MOBILE_AUTHORITY) }

            DESKTOP_UI_TOKEN.matches(token) -> store.findDesktopUiSession(tokens.uiSessionHash(token), now)
                ?.let { principal(it.principal, it.origin, DESKTOP_UI_AUTHORITY) }

            else -> null
        }
        return principal ?: throw BadOpaqueTokenException("Invalid bearer token")
    }

    private fun principal(
        session: SessionPrincipal,
        origin: String?,
        authority: String,
    ): OAuth2AuthenticatedPrincipal {
        val attributes = mutableMapOf<String, Any>(
            "sub" to session.userId.toString(),
            "session" to session,
        )
        origin?.let { attributes["origin"] = it }
        return DefaultOAuth2AuthenticatedPrincipal(
            session.userId.toString(),
            attributes,
            listOf(SimpleGrantedAuthority(authority)),
        )
    }

    private companion object {
        val DESKTOP_TOKEN = Regex("^jbd_[a-f0-9]{64}$")
        val MOBILE_TOKEN = Regex("^jbs_[a-f0-9]{64}$")
        val DESKTOP_UI_TOKEN = Regex("^jbui_[a-f0-9]{64}$")
    }
}
