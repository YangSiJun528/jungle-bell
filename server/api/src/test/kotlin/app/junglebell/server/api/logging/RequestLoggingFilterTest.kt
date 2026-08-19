package app.junglebell.server.api.logging

import app.junglebell.server.common.logging.LoggingContext
import app.junglebell.server.domain.security.SessionKind
import app.junglebell.server.domain.security.SessionPrincipal
import jakarta.servlet.FilterChain
import java.util.UUID
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotEquals
import kotlin.test.assertNull
import org.slf4j.MDC
import org.springframework.mock.web.MockHttpServletRequest
import org.springframework.mock.web.MockHttpServletResponse
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken
import org.springframework.security.core.context.SecurityContextHolder
import org.springframework.security.oauth2.core.DefaultOAuth2AuthenticatedPrincipal

class RequestLoggingFilterTest {
    @AfterTest
    fun clearContexts() {
        SecurityContextHolder.clearContext()
        LoggingContext.clearCorrelationIds()
    }

    @Test
    fun `request id filter preserves a safe client identifier`() {
        val request = MockHttpServletRequest().apply { addHeader(REQUEST_ID_HEADER, "client-request_123") }
        val response = MockHttpServletResponse()

        RequestIdFilter().doFilter(request, response, FilterChain { _, _ ->
            assertEquals("client-request_123", MDC.get(LoggingContext.REQUEST_ID))
        })

        assertEquals("client-request_123", response.getHeader(REQUEST_ID_HEADER))
        assertNull(MDC.get(LoggingContext.REQUEST_ID))
    }

    @Test
    fun `request id filter creates a UUID when the identifier is missing`() {
        val response = MockHttpServletResponse()
        var observed: String? = null

        RequestIdFilter().doFilter(MockHttpServletRequest(), response, FilterChain { _, _ ->
            observed = MDC.get(LoggingContext.REQUEST_ID)
        })

        UUID.fromString(observed)
        assertEquals(observed, response.getHeader(REQUEST_ID_HEADER))
    }

    @Test
    fun `request id filter replaces an unsafe identifier with a UUID`() {
        val request = MockHttpServletRequest().apply { addHeader(REQUEST_ID_HEADER, "unsafe request id") }
        val response = MockHttpServletResponse()
        var observed: String? = null

        RequestIdFilter().doFilter(request, response, FilterChain { _, _ ->
            observed = MDC.get(LoggingContext.REQUEST_ID)
        })

        assertNotEquals("unsafe request id", observed)
        UUID.fromString(observed)
        assertEquals(observed, response.getHeader(REQUEST_ID_HEADER))
    }

    @Test
    fun `request id filter clears MDC when the chain fails`() {
        val response = MockHttpServletResponse()
        assertFailsWith<IllegalStateException> {
            RequestIdFilter().doFilter(
                MockHttpServletRequest(),
                response,
                FilterChain { _, _ -> throw IllegalStateException("failed") },
            )
        }

        UUID.fromString(response.getHeader(REQUEST_ID_HEADER))
        assertNull(MDC.get(LoggingContext.REQUEST_ID))
    }

    @Test
    fun `authenticated user filter adds user id only around downstream processing`() {
        val session = SessionPrincipal(UUID.randomUUID(), UUID.randomUUID(), "installation", SessionKind.DESKTOP)
        val principal = DefaultOAuth2AuthenticatedPrincipal(
            session.userId.toString(),
            mapOf("session" to session),
            emptyList(),
        )
        SecurityContextHolder.getContext().authentication = UsernamePasswordAuthenticationToken.authenticated(
            principal,
            "",
            emptyList(),
        )
        MDC.put(LoggingContext.REQUEST_ID, "request-1")

        AuthenticatedUserMdcFilter().doFilter(
            MockHttpServletRequest(),
            MockHttpServletResponse(),
            FilterChain { _, _ ->
                assertEquals("request-1", MDC.get(LoggingContext.REQUEST_ID))
                assertEquals(session.userId.toString(), MDC.get(LoggingContext.USER_ID))
            },
        )

        assertEquals("request-1", MDC.get(LoggingContext.REQUEST_ID))
        assertNull(MDC.get(LoggingContext.USER_ID))
    }
}
