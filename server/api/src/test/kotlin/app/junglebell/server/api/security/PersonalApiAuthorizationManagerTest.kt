package app.junglebell.server.api.security

import app.junglebell.server.common.config.JungleBellProperties
import app.junglebell.server.domain.security.SessionKind
import app.junglebell.server.domain.security.SessionPrincipal
import java.net.URI
import java.util.UUID
import java.util.function.Supplier
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import org.springframework.mock.web.MockHttpServletRequest
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken
import org.springframework.security.core.Authentication
import org.springframework.security.core.authority.SimpleGrantedAuthority
import org.springframework.security.oauth2.core.DefaultOAuth2AuthenticatedPrincipal
import org.springframework.security.web.access.intercept.RequestAuthorizationContext

class PersonalApiAuthorizationManagerTest {
    private val properties = JungleBellProperties(
        URI("https://example.test"),
        setOf("tauri://localhost"),
        "p".repeat(32),
        collectors = JungleBellProperties.CollectorProperties(false, null, null, null),
    )

    @Test
    fun `mobile session can use ordinary personal APIs`() {
        val manager = PersonalApiAuthorizationManager(properties, allowMobile = true)

        assertTrue(manager.check(authentication(MOBILE_AUTHORITY), origin = null))
    }

    @Test
    fun `mobile session cannot use desktop UI capabilities`() {
        val manager = PersonalApiAuthorizationManager(properties, allowMobile = false)

        assertFalse(manager.check(authentication(MOBILE_AUTHORITY), origin = null))
    }

    @Test
    fun `desktop UI session requires its exact allowed origin`() {
        val manager = PersonalApiAuthorizationManager(properties, allowMobile = true)
        val authentication = authentication(DESKTOP_UI_AUTHORITY, "tauri://localhost")

        assertTrue(manager.check(authentication, "tauri://localhost"))
        assertFalse(manager.check(authentication, "http://tauri.localhost"))
        assertFalse(manager.check(authentication, null))
    }

    @Test
    fun `long lived desktop token cannot call personal APIs`() {
        val manager = PersonalApiAuthorizationManager(properties, allowMobile = true)

        assertFalse(manager.check(authentication(DESKTOP_AUTHORITY), "tauri://localhost"))
    }

    private fun PersonalApiAuthorizationManager.check(
        authentication: Authentication,
        origin: String?,
    ): Boolean {
        val request = MockHttpServletRequest("GET", "/api/me/attendance")
        origin?.let { request.addHeader("Origin", it) }
        return authorize(Supplier { authentication }, RequestAuthorizationContext(request)).isGranted
    }

    private fun authentication(authority: String, origin: String? = null): Authentication {
        val kind = if (authority == MOBILE_AUTHORITY) SessionKind.MOBILE else SessionKind.DESKTOP
        val session = SessionPrincipal(UUID.randomUUID(), UUID.randomUUID(), "installation", kind)
        val attributes = mutableMapOf<String, Any>("sub" to session.userId.toString(), "session" to session)
        origin?.let { attributes["origin"] = it }
        val authorities = listOf(SimpleGrantedAuthority(authority))
        val principal = DefaultOAuth2AuthenticatedPrincipal(session.userId.toString(), attributes, authorities)
        return UsernamePasswordAuthenticationToken.authenticated(
            principal,
            null,
            authorities,
        )
    }
}
