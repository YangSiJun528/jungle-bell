package app.junglebell.server.account

import app.junglebell.server.common.ApiException
import app.junglebell.server.config.JungleBellProperties
import app.junglebell.server.security.TokenCodec
import org.mockito.ArgumentMatchers.anyInt
import org.mockito.ArgumentMatchers.anyLong
import org.mockito.ArgumentMatchers.anyString
import org.mockito.Mockito.mock
import org.mockito.Mockito.mockingDetails
import org.mockito.Mockito.never
import org.mockito.Mockito.verify
import org.mockito.Mockito.`when`
import java.net.URI
import java.time.Clock
import java.time.Instant
import java.time.ZoneOffset
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
        val repository = mock(AccountRepository::class.java)
        `when`(repository.consumeEnrollmentAttempt(anyString(), anyLong(), anyLong(), anyInt())).thenReturn(true)
        `when`(repository.desktopExists("desktop-installation-1")).thenReturn(false)
        val service = service(repository)

        val response = service.enroll(DesktopInstallationRequest("desktop-installation-1"), "203.0.113.7")

        assertTrue(response.accessToken.matches(Regex("^jbd_[a-f0-9]{64}$")))
        assertEquals(now.plusSeconds(90L * 24 * 60 * 60).toString(), response.expiresAt)
        verify(repository).consumeEnrollmentAttempt(
            TokenCodec(properties).plainHash("desktop-enrollment:ip:203.0.113.7"),
            now.toEpochMilli(),
            600_000,
            240,
        )
        verify(repository).consumeEnrollmentAttempt(
            TokenCodec(properties).plainHash("desktop-enrollment:installation:desktop-installation-1"),
            now.toEpochMilli(),
            600_000,
            10,
        )
        val creation = mockingDetails(repository).invocations.single { it.method.name == "createDesktop" }
        assertEquals("desktop-installation-1", creation.arguments[1])
        assertTrue((creation.arguments[3] as String).matches(Regex("^[a-f0-9]{64}$")))
        assertEquals(now.toEpochMilli(), creation.arguments[4])
        assertEquals(now.plusSeconds(90L * 24 * 60 * 60).toEpochMilli(), creation.arguments[5])
    }

    @Test
    fun enrollStopsBeforeLookupWhenRateLimitIsExhausted() {
        val repository = mock(AccountRepository::class.java)
        `when`(repository.consumeEnrollmentAttempt(anyString(), anyLong(), anyLong(), anyInt()))
            .thenReturn(true, false)
        val service = service(repository)

        val error = assertFailsWith<ApiException> {
            service.enroll(DesktopInstallationRequest("desktop-installation-2"), "203.0.113.8")
        }

        assertEquals("DESKTOP_ENROLLMENT_RATE_LIMITED", error.code)
        assertEquals(429, error.status.value())
        verify(repository, never()).desktopExists("desktop-installation-2")
        assertTrue(mockingDetails(repository).invocations.none { it.method.name == "createDesktop" })
    }

    private fun service(repository: AccountRepository) = AccountService(
        repository,
        TokenCodec(properties),
        properties,
        Clock.fixed(now, ZoneOffset.UTC),
    )
}
