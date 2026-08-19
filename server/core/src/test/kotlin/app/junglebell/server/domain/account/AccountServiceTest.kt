package app.junglebell.server.domain.account

import app.junglebell.server.common.error.ApiException
import app.junglebell.server.common.config.JungleBellProperties
import app.junglebell.server.domain.security.SessionKind
import app.junglebell.server.domain.security.SessionPrincipal
import app.junglebell.server.domain.security.TokenCodec
import org.mockito.Answers
import org.mockito.Mockito.mock
import org.mockito.Mockito.mockingDetails
import java.net.URI
import java.time.Clock
import java.time.Instant
import java.time.ZoneOffset
import java.util.UUID
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class AccountServiceTest {
    private val now = Instant.parse("2026-08-13T09:30:00Z")
    private val properties = JungleBellProperties(
        publicBaseUrl = URI("https://example.test"),
        allowedDesktopOrigins = setOf("tauri://localhost"),
        pairingSecret = "p".repeat(32),
        collectors = JungleBellProperties.CollectorProperties(false, null, null, null),
    )

    @Test
    fun enrollConsumesBothRateLimitsBeforeCreatingDesktop() {
        val store = enrollmentStore()
        val service = service(store)

        val response = service.enroll(DesktopInstallationRequest("desktop-installation-1"), "203.0.113.7")

        assertTrue(response.accessToken.matches(Regex("^jbd_[a-f0-9]{64}$")))
        assertEquals(now.plusSeconds(90L * 24 * 60 * 60).toString(), response.expiresAt)
        val enrollment = mockingDetails(store).invocations.single { it.method.name == "enrollDesktop" }
        @Suppress("UNCHECKED_CAST")
        val limits = enrollment.arguments[0] as List<EnrollmentRateLimit>
        assertEquals(
            listOf(
                EnrollmentRateLimit(TokenCodec(properties).plainHash("desktop-enrollment:ip:203.0.113.7"), 240),
                EnrollmentRateLimit(
                    TokenCodec(properties).plainHash("desktop-enrollment:installation:desktop-installation-1"),
                    10,
                ),
            ),
            limits,
        )
        assertEquals(600_000L, enrollment.arguments[1])
        assertEquals("desktop-installation-1", enrollment.arguments[3])
        assertTrue((enrollment.arguments[5] as String).matches(Regex("^[a-f0-9]{64}$")))
        assertEquals(now.toEpochMilli(), enrollment.arguments[6])
        assertEquals(now.plusSeconds(90L * 24 * 60 * 60).toEpochMilli(), enrollment.arguments[7])
    }

    @Test
    fun enrollStopsBeforeLookupWhenRateLimitIsExhausted() {
        val store = enrollmentStore(DesktopEnrollmentRateLimitedException())
        val service = service(store)

        val error = assertFailsWith<ApiException> {
            service.enroll(DesktopInstallationRequest("desktop-installation-2"), "203.0.113.8")
        }

        assertEquals("DESKTOP_ENROLLMENT_RATE_LIMITED", error.code)
        assertEquals(429, error.status.value())
        assertEquals(1, mockingDetails(store).invocations.count { it.method.name == "enrollDesktop" })
    }

    @Test
    fun enrollRejectsAnExistingDesktop() {
        val store = enrollmentStore(DesktopAlreadyEnrolledException())
        val service = service(store)

        val error = assertFailsWith<ApiException> {
            service.enroll(DesktopInstallationRequest("desktop-installation-3"), "203.0.113.9")
        }

        assertEquals("DESKTOP_ALREADY_ENROLLED", error.code)
        assertEquals(409, error.status.value())
    }

    @Test
    fun deleteDesktopIdentityRequiresTheCurrentDesktopRow() {
        val store = mock(AccountStore::class.java) { invocation ->
            if (invocation.method.name == "deleteDesktopIdentity") false
            else Answers.RETURNS_DEFAULTS.answer(invocation)
        }
        val principal = SessionPrincipal(
            UUID.randomUUID(),
            UUID.randomUUID(),
            "desktop-installation-4",
            SessionKind.DESKTOP,
        )

        val error = assertFailsWith<ApiException> {
            service(store).deleteDesktopIdentity(principal)
        }

        assertEquals("DESKTOP_IDENTITY_DELETION_REJECTED", error.code)
        assertEquals(409, error.status.value())
        assertEquals(
            1,
            mockingDetails(store).invocations.count { it.method.name == "deleteDesktopIdentity" },
        )
    }

    private fun enrollmentStore(failure: RuntimeException? = null): AccountStore =
        mock(AccountStore::class.java) { invocation ->
            if (invocation.method.name == "enrollDesktop" && failure != null) throw failure
            Answers.RETURNS_DEFAULTS.answer(invocation)
        }

    private fun service(store: AccountStore) = AccountService(
        store,
        TokenCodec(properties),
        properties,
        Clock.fixed(now, ZoneOffset.UTC),
    )
}
