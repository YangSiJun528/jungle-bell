package app.junglebell.server.api.usage

import app.junglebell.server.api.common.ApiErrorResponse
import app.junglebell.server.domain.security.SessionKind
import app.junglebell.server.domain.security.SessionPrincipal
import app.junglebell.server.domain.usage.AnonymousUsageIdentity
import app.junglebell.server.domain.usage.AnonymousUsageRecorder
import app.junglebell.server.domain.usage.AnonymousUsageRecording
import app.junglebell.server.domain.usage.UsageClient
import app.junglebell.server.domain.usage.UsagePreferenceService
import app.junglebell.server.domain.usage.UsageRecorder
import app.junglebell.server.domain.usage.UsageRecordingOutcome
import jakarta.servlet.http.Cookie
import java.util.UUID
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue
import org.mockito.Mockito.mock
import org.mockito.Mockito.verifyNoInteractions
import org.mockito.Mockito.`when`
import org.springframework.http.HttpHeaders
import org.springframework.http.HttpStatus
import org.springframework.mock.web.MockHttpServletRequest
import org.springframework.mock.web.MockHttpServletResponse

class UsageControllerTest {
    private val authenticated = mock(UsageRecorder::class.java)
    private val anonymous = mock(AnonymousUsageRecorder::class.java)
    private val controller = UsageController(
        authenticated,
        anonymous,
        mock(UsagePreferenceService::class.java),
    )

    @Test
    fun `successful skipped and deduplicated authenticated UI opens return 204`() {
        val principal = principal()

        listOf(
            UsageRecordingOutcome.RECORDED,
            UsageRecordingOutcome.NO_CHANGE,
            UsageRecordingOutcome.SKIPPED,
        ).forEach { outcome ->
            `when`(authenticated.recordUiOpened(principal)).thenReturn(outcome)

            assertEquals(HttpStatus.NO_CONTENT, controller.authenticatedUiOpened(principal).statusCode)
        }
    }

    @Test
    fun `temporarily unavailable authenticated UI open returns retryable 503`() {
        val principal = principal()
        `when`(authenticated.recordUiOpened(principal)).thenReturn(UsageRecordingOutcome.UNAVAILABLE)

        val result = controller.authenticatedUiOpened(principal)

        assertEquals(HttpStatus.SERVICE_UNAVAILABLE, result.statusCode)
        assertEquals("1", result.headers.getFirst(HttpHeaders.RETRY_AFTER))
        assertEquals(ApiErrorResponse("USAGE_METRICS_UNAVAILABLE"), result.body)
    }

    @Test
    fun `unexpected authenticated UI failure propagates as a server error`() {
        val principal = principal()
        `when`(authenticated.recordUiOpened(principal)).thenThrow(IllegalStateException("unexpected"))

        assertFailsWith<IllegalStateException> {
            controller.authenticatedUiOpened(principal)
        }
    }

    @Test
    fun `anonymous unavailable response retains a newly issued retry identity`() {
        val token = "jbv_${"a".repeat(64)}"
        `when`(anonymous.recordUiOpened(null, UsageClient.WEB))
            .thenReturn(
                AnonymousUsageRecording(
                    AnonymousUsageIdentity(token, newToken = true),
                    UsageRecordingOutcome.UNAVAILABLE,
                ),
            )
        val request = MockHttpServletRequest("POST", "/api/public/usage/ui-opened").apply {
            isSecure = true
        }
        val response = MockHttpServletResponse()

        val result = controller.anonymousUiOpened(
            AnonymousUiOpenedRequest("web"),
            request,
            response,
        )

        assertEquals(HttpStatus.SERVICE_UNAVAILABLE, result.statusCode)
        assertEquals("1", result.headers.getFirst(HttpHeaders.RETRY_AFTER))
        assertEquals(ApiErrorResponse("USAGE_METRICS_UNAVAILABLE"), result.body)
        assertTrue(
            response.getHeaders(HttpHeaders.SET_COOKIE).any {
                it.startsWith("__Host-jb_usage=$token;") && it.contains("Max-Age=86400")
            },
        )
    }

    @Test
    fun `anonymous opt out returns 204 without invoking the recorder`() {
        val request = MockHttpServletRequest("POST", "/api/public/usage/ui-opened").apply {
            isSecure = true
            setCookies(Cookie("__Host-jb_usage_opt_out", "1"))
        }

        val result = controller.anonymousUiOpened(
            AnonymousUiOpenedRequest("web"),
            request,
            MockHttpServletResponse(),
        )

        assertEquals(HttpStatus.NO_CONTENT, result.statusCode)
        verifyNoInteractions(anonymous)
    }

    private fun principal() = SessionPrincipal(
        sessionId = UUID.randomUUID(),
        userId = UUID.randomUUID(),
        installationId = "installation",
        kind = SessionKind.DESKTOP,
    )
}
