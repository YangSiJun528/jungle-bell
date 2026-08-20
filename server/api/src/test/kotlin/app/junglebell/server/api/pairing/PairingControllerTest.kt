package app.junglebell.server.api.pairing

import app.junglebell.server.domain.pairing.PairingClaim
import app.junglebell.server.domain.pairing.PairingHandoffClaimRequest
import app.junglebell.server.domain.pairing.PairingService
import app.junglebell.server.domain.pairing.QrPairingHandoffRequest
import app.junglebell.server.domain.usage.UsageRecorder
import jakarta.servlet.http.Cookie
import java.util.UUID
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import org.mockito.Mockito.mock
import org.mockito.Mockito.verifyNoInteractions
import org.mockito.Mockito.`when`
import org.springframework.http.HttpHeaders
import org.springframework.http.HttpStatus
import org.springframework.http.MediaType
import org.springframework.mock.web.MockHttpServletRequest
import org.springframework.mock.web.MockHttpServletResponse
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.status
import org.springframework.test.web.servlet.setup.MockMvcBuilders

class PairingControllerTest {
    private val service = mock(PairingService::class.java)
    private val controller = PairingController(service, mock(UsageRecorder::class.java))

    @Test
    fun `preparing an install handoff sets only short-lived hardened cookies`() {
        val pairingId = "jbp_${UUID.randomUUID()}"
        val challenge = "jbpc_${"a".repeat(64)}"
        `when`(service.prepareHandoff(pairingId, challenge))
            .thenReturn(System.currentTimeMillis() + 10 * 60_000)
        val request = secureRequest("/api/pairings/$pairingId/handoff")
        val response = MockHttpServletResponse()

        controller.prepareHandoff(
            pairingId,
            QrPairingHandoffRequest(challenge),
            request,
            response,
        )

        val cookies = response.getHeaders(HttpHeaders.SET_COOKIE)
        assertTrue(cookies.any { it.startsWith("__Host-jb_pending_claim=;") && it.contains("Max-Age=0") })
        assertTrue(cookies.any {
            it.startsWith("__Host-jb_pairing_handoff=$challenge;") &&
                it.contains("Path=/") && it.contains("Secure") &&
                it.contains("HttpOnly") && it.contains("SameSite=Strict")
        })
    }

    @Test
    fun `PWA handoff claim rotates the handoff into the pending receipt cookie`() {
        val pairingId = "jbp_${UUID.randomUUID()}"
        val challenge = "jbpc_${"b".repeat(64)}"
        val receipt = "jbcr_${"c".repeat(64)}"
        val body = PairingHandoffClaimRequest(
            "설치된 Jungle Bell",
            "jbmi_0123456789abcdef0123456789abcdef",
        )
        `when`(service.claimHandoff(challenge, body)).thenReturn(
            PairingClaim(pairingId, receipt, System.currentTimeMillis() + 10 * 60_000),
        )
        val request = secureRequest("/api/pairings/handoffs/claims").apply {
            setCookies(Cookie("__Host-jb_pairing_handoff", challenge))
        }
        val response = MockHttpServletResponse()

        val result = controller.claimHandoff(body, request, response)

        assertEquals(HttpStatus.CREATED, result.statusCode)
        assertEquals(pairingId, result.body?.claimId)
        val cookies = response.getHeaders(HttpHeaders.SET_COOKIE)
        assertTrue(cookies.any { it.startsWith("__Host-jb_pairing_handoff=;") && it.contains("Max-Age=0") })
        assertTrue(cookies.any { it.startsWith("__Host-jb_pending_claim=$receipt;") })
    }

    @Test
    fun `PWA without an install handoff receives a no-op response`() {
        val request = secureRequest("/api/pairings/handoffs/claims")
        val response = MockHttpServletResponse()

        val result = controller.claimHandoff(
            PairingHandoffClaimRequest(
                "설치된 Jungle Bell",
                "jbmi_0123456789abcdef0123456789abcdef",
            ),
            request,
            response,
        )

        assertEquals(HttpStatus.NO_CONTENT, result.statusCode)
        assertTrue(response.getHeaders(HttpHeaders.SET_COOKIE).isEmpty())
        verifyNoInteractions(service)
    }

    @Test
    fun `handoff claim route wins over the pairing id claim route`() {
        val mockMvc = MockMvcBuilders.standaloneSetup(controller).build()

        mockMvc.perform(
            post("/api/pairings/handoffs/claims")
                .secure(true)
                .contentType(MediaType.APPLICATION_JSON)
                .content(
                    """
                    {
                      "deviceLabel": "설치된 Jungle Bell",
                      "installationId": "jbmi_0123456789abcdef0123456789abcdef"
                    }
                    """.trimIndent(),
                ),
        ).andExpect(status().isNoContent)

        verifyNoInteractions(service)
    }

    private fun secureRequest(path: String) = MockHttpServletRequest("POST", path).apply {
        isSecure = true
    }
}
