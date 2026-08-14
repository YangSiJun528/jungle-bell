package app.junglebell.server.api.security

import jakarta.servlet.http.Cookie
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import org.springframework.http.HttpHeaders
import org.springframework.mock.web.MockHttpServletRequest

class JungleBellBearerTokenResolverTest {
    private val resolver = JungleBellBearerTokenResolver()

    @Test
    fun `desktop APIs use the authorization header`() {
        val request = MockHttpServletRequest("GET", "/api/desktop/attendance").apply {
            addHeader(HttpHeaders.AUTHORIZATION, "Bearer desktop-token")
        }

        assertEquals("desktop-token", resolver.resolve(request))
    }

    @Test
    fun `personal APIs prefer a bearer token over the mobile cookie`() {
        val request = MockHttpServletRequest("GET", "/api/me/attendance").apply {
            addHeader(HttpHeaders.AUTHORIZATION, "Bearer desktop-ui-token")
            setCookies(Cookie("__Host-jb_device", "mobile-token"))
        }

        assertEquals("desktop-ui-token", resolver.resolve(request))
    }

    @Test
    fun `personal APIs use the host mobile cookie`() {
        val request = MockHttpServletRequest("GET", "/api/me/attendance").apply {
            setCookies(
                Cookie("jb_device", "fallback-token"),
                Cookie("__Host-jb_device", "host-token"),
            )
        }

        assertEquals("host-token", resolver.resolve(request))
    }

    @Test
    fun `public endpoints never start bearer authentication`() {
        val request = MockHttpServletRequest("GET", "/api/public/status").apply {
            addHeader(HttpHeaders.AUTHORIZATION, "Bearer ignored-token")
        }

        assertNull(resolver.resolve(request))
    }

    @Test
    fun `desktop enrollment stays public even with an authorization header`() {
        val request = MockHttpServletRequest("POST", "/api/desktop/installations").apply {
            addHeader(HttpHeaders.AUTHORIZATION, "Bearer ignored-token")
        }

        assertNull(resolver.resolve(request))
    }
}
