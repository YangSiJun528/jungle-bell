package app.junglebell.server.api.security

import app.junglebell.server.common.config.JungleBellProperties
import java.util.function.Supplier
import org.springframework.security.authorization.AuthorizationDecision
import org.springframework.security.authorization.AuthorizationManager
import org.springframework.security.authorization.AuthorizationResult
import org.springframework.security.core.Authentication
import org.springframework.security.oauth2.core.OAuth2AuthenticatedPrincipal
import org.springframework.security.web.access.intercept.RequestAuthorizationContext

class PersonalApiAuthorizationManager(
    properties: JungleBellProperties,
    private val allowMobile: Boolean,
) : AuthorizationManager<RequestAuthorizationContext> {
    private val allowedDesktopOrigins = properties.allowedDesktopOrigins

    override fun authorize(
        authentication: Supplier<out Authentication?>,
        context: RequestAuthorizationContext,
    ): AuthorizationResult {
        val current = authentication.get()
        val granted = when {
            current == null || !current.isAuthenticated -> false
            current.hasAuthority(MOBILE_AUTHORITY) -> allowMobile
            current.hasAuthority(DESKTOP_UI_AUTHORITY) -> {
                val origin = context.request.getHeader("Origin")
                origin != null && origin == current.desktopUiOrigin() && origin in allowedDesktopOrigins
            }
            else -> false
        }
        return AuthorizationDecision(granted)
    }

    private fun Authentication.hasAuthority(value: String): Boolean = authorities.any { it.authority == value }

    private fun Authentication.desktopUiOrigin(): String? =
        (principal as? OAuth2AuthenticatedPrincipal)?.getAttribute("origin")
}
