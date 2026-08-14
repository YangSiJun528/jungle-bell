package app.junglebell.server.api.security

import app.junglebell.server.common.config.JungleBellProperties
import app.junglebell.server.domain.security.AuthStore
import app.junglebell.server.domain.security.SessionKind
import app.junglebell.server.domain.security.SessionPrincipal
import app.junglebell.server.domain.security.StoredDesktopUiSession
import app.junglebell.server.domain.security.TokenCodec
import java.net.URI
import java.time.Clock
import java.time.Instant
import java.time.ZoneOffset
import java.util.UUID
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import org.springframework.security.oauth2.server.resource.introspection.BadOpaqueTokenException

class JungleBellOpaqueTokenIntrospectorTest {
    private val now = Instant.parse("2026-08-14T08:00:00Z")
    private val properties = JungleBellProperties(
        URI("https://example.test"),
        setOf("tauri://localhost"),
        "p".repeat(32),
        collectors = JungleBellProperties.CollectorProperties(false, null, null, null),
    )
    private val tokens = TokenCodec(properties)

    @Test
    fun `desktop token becomes a desktop authority`() {
        val token = "jbd_" + "a".repeat(64)
        val principal = session(SessionKind.DESKTOP)
        val store = RecordingAuthStore(appSession = principal)

        val result = introspector(store).introspect(token)

        assertEquals(principal, result.getAttribute("session"))
        assertEquals(setOf(DESKTOP_AUTHORITY), result.authorities.map { it.authority }.toSet())
        assertEquals(tokens.sessionHash(token), store.appTokenHash)
        assertEquals(now.toEpochMilli(), store.now)
    }

    @Test
    fun `mobile token rejects a desktop session`() {
        val token = "jbs_" + "b".repeat(64)
        val store = RecordingAuthStore(appSession = session(SessionKind.DESKTOP))

        assertFailsWith<BadOpaqueTokenException> { introspector(store).introspect(token) }
    }

    @Test
    fun `desktop UI token carries its bound origin`() {
        val token = "jbui_" + "c".repeat(64)
        val principal = session(SessionKind.DESKTOP)
        val store = RecordingAuthStore(desktopUiSession = StoredDesktopUiSession(principal, "tauri://localhost"))

        val result = introspector(store).introspect(token)

        assertEquals(principal, result.getAttribute("session"))
        assertEquals("tauri://localhost", result.getAttribute("origin"))
        assertEquals(setOf(DESKTOP_UI_AUTHORITY), result.authorities.map { it.authority }.toSet())
        assertEquals(tokens.uiSessionHash(token), store.uiTokenHash)
    }

    @Test
    fun `invalid token format does not query the store`() {
        val store = RecordingAuthStore()

        assertFailsWith<BadOpaqueTokenException> { introspector(store).introspect("not-a-token") }
        assertNull(store.appTokenHash)
        assertNull(store.uiTokenHash)
    }

    private fun introspector(store: AuthStore) = JungleBellOpaqueTokenIntrospector(
        store,
        tokens,
        Clock.fixed(now, ZoneOffset.UTC),
    )

    private fun session(kind: SessionKind) = SessionPrincipal(
        UUID.randomUUID(),
        UUID.randomUUID(),
        "installation-${UUID.randomUUID()}",
        kind,
    )
}

private class RecordingAuthStore(
    private val appSession: SessionPrincipal? = null,
    private val desktopUiSession: StoredDesktopUiSession? = null,
) : AuthStore {
    var appTokenHash: String? = null
    var uiTokenHash: String? = null
    var now: Long? = null

    override fun authenticateAppSession(tokenHash: String, now: Long): SessionPrincipal? {
        appTokenHash = tokenHash
        this.now = now
        return appSession
    }

    override fun findDesktopUiSession(tokenHash: String, now: Long): StoredDesktopUiSession? {
        uiTokenHash = tokenHash
        this.now = now
        return desktopUiSession
    }
}
