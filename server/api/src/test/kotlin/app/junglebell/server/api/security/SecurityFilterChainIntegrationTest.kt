package app.junglebell.server.api.security

import app.junglebell.server.domain.security.TokenCodec
import jakarta.servlet.http.Cookie
import java.util.UUID
import kotlin.test.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.testcontainers.service.connection.ServiceConnection
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc
import org.springframework.http.HttpHeaders
import org.springframework.http.MediaType
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.content
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.forwardedUrl
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.header
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.status
import org.testcontainers.junit.jupiter.Container
import org.testcontainers.junit.jupiter.Testcontainers
import org.testcontainers.postgresql.PostgreSQLContainer

@Testcontainers(disabledWithoutDocker = true)
@AutoConfigureMockMvc
@SpringBootTest
class SecurityFilterChainIntegrationTest(
    @param:Autowired private val mockMvc: MockMvc,
    @param:Autowired private val jdbc: JdbcClient,
    @param:Autowired private val tokens: TokenCodec,
) {
    @Test
    fun `React SPA is served at the root without legacy entry routes`() {
        mockMvc.perform(get("/"))
            .andExpect(status().isOk)
            .andExpect(forwardedUrl("index.html"))
        mockMvc.perform(get("/index.html"))
            .andExpect(status().isOk)
            .andExpect(content().contentTypeCompatibleWith(MediaType.TEXT_HTML))
            .andExpect(content().string(org.hamcrest.Matchers.containsString("id=\"root\"")))
        mockMvc.perform(get("/blog")).andExpect(status().isNotFound)
        mockMvc.perform(get("/blog/")).andExpect(status().isNotFound)
        mockMvc.perform(get("/dashboard.html")).andExpect(status().isNotFound)
    }

    @Test
    fun `missing credentials return the API authentication error`() {
        mockMvc.perform(get("/api/me/session"))
            .andExpect(status().isUnauthorized)
            .andExpect(jsonPath("$.error").value("AUTHENTICATION_REQUIRED"))
    }

    @Test
    fun `desktop webview origin can read public API responses`() {
        mockMvc.perform(
            get("/api/public/status")
                .header(HttpHeaders.ORIGIN, "tauri://localhost"),
        ).andExpect(status().isOk)
            .andExpect(header().string(HttpHeaders.ACCESS_CONTROL_ALLOW_ORIGIN, "tauri://localhost"))
    }

    @Test
    fun `invalid bearer returns the API authentication error`() {
        mockMvc.perform(
            get("/api/desktop/attendance")
                .header(HttpHeaders.AUTHORIZATION, "Bearer invalid-token"),
        ).andExpect(status().isUnauthorized)
            .andExpect(jsonPath("$.error").value("AUTHENTICATION_REQUIRED"))
    }

    @Test
    fun `mobile cookie authenticates ordinary personal APIs`() {
        val token = "jbs_" + "a".repeat(64)
        createAppSession("mobile", token)

        mockMvc.perform(get("/api/me/session").cookie(Cookie("jb_device", token)))
            .andExpect(status().isOk)
    }

    @Test
    fun `mobile cookie cannot use desktop UI capabilities`() {
        val token = "jbs_" + "b".repeat(64)
        createAppSession("mobile", token)

        mockMvc.perform(get("/api/me/pairings/jbp_${UUID.randomUUID()}").cookie(Cookie("jb_device", token)))
            .andExpect(status().isForbidden)
            .andExpect(jsonPath("$.error").value("DESKTOP_CAPABILITY_REQUIRED"))
    }

    @Test
    fun `desktop bearer authenticates desktop APIs`() {
        val token = "jbd_" + "c".repeat(64)
        createAppSession("desktop", token)

        mockMvc.perform(
            get("/api/desktop/attendance")
                .header(HttpHeaders.AUTHORIZATION, "Bearer $token"),
        ).andExpect(status().isOk)
    }

    @Test
    fun `long lived desktop bearer cannot replace a desktop UI token`() {
        val token = "jbd_" + "e".repeat(64)
        createAppSession("desktop", token)

        mockMvc.perform(
            get("/api/me/attendance")
                .header(HttpHeaders.AUTHORIZATION, "Bearer $token")
                .header(HttpHeaders.ORIGIN, "tauri://localhost"),
        ).andExpect(status().isForbidden)
            .andExpect(jsonPath("$.error").value("SESSION_KIND_DENIED"))
    }

    @Test
    fun `desktop UI bearer requires its bound origin`() {
        val token = "jbui_" + "d".repeat(64)
        createDesktopUiSession(token, "tauri://localhost")

        mockMvc.perform(
            get("/api/me/attendance")
                .header(HttpHeaders.AUTHORIZATION, "Bearer $token")
                .header(HttpHeaders.ORIGIN, "tauri://localhost"),
        ).andExpect(status().isOk)

        mockMvc.perform(
            get("/api/me/attendance")
                .header(HttpHeaders.AUTHORIZATION, "Bearer $token")
                .header(HttpHeaders.ORIGIN, "http://tauri.localhost"),
        ).andExpect(status().isForbidden)
            .andExpect(jsonPath("$.error").value("ORIGIN_NOT_ALLOWED"))
    }

    private fun createAppSession(kind: String, token: String): UUID {
        val userId = UUID.randomUUID()
        val sessionId = UUID.randomUUID()
        val installationId = "$kind-${UUID.randomUUID()}"
        val now = System.currentTimeMillis()
        jdbc.sql("INSERT INTO app_user(id, created_at_epoch_ms) VALUES (:userId, :now)")
            .param("userId", userId).param("now", now).update()
        if (kind == "desktop") {
            jdbc.sql(
                """
                INSERT INTO desktop_device(
                    installation_id, user_id, created_at_epoch_ms, activated_at_epoch_ms,
                    last_seen_at_epoch_ms, lms_session_state, app_version
                ) VALUES (:installationId, :userId, :now, :now, :now, 'connected', 'test')
                """.trimIndent(),
            ).param("installationId", installationId).param("userId", userId).param("now", now).update()
        }
        jdbc.sql(
            """
            INSERT INTO app_session(
                id, user_id, installation_id, kind, label, token_sha256,
                created_at_epoch_ms, expires_at_epoch_ms, last_seen_at_epoch_ms,
                revoked_at_epoch_ms, source_pairing_id
            ) VALUES (:id, :userId, :installationId, :kind, NULL, :tokenHash,
                :now, :expiresAt, :now, NULL, NULL)
            """.trimIndent(),
        ).param("id", sessionId).param("userId", userId).param("installationId", installationId)
            .param("kind", kind).param("tokenHash", tokens.sessionHash(token))
            .param("now", now).param("expiresAt", now + 60_000).update()
        return sessionId
    }

    private fun createDesktopUiSession(token: String, origin: String) {
        val parentToken = "jbd_" + UUID.randomUUID().toString().replace("-", "").repeat(2)
        val parentSessionId = createAppSession("desktop", parentToken)
        val parent = jdbc.sql(
            "SELECT user_id, installation_id FROM app_session WHERE id = :id",
        ).param("id", parentSessionId).query { row, _ ->
            row.getObject("user_id", UUID::class.java) to row.getString("installation_id")
        }.single()
        val now = System.currentTimeMillis()
        jdbc.sql(
            """
            INSERT INTO desktop_ui_session(
                id, parent_session_id, user_id, installation_id, token_sha256,
                origin, scope, created_at_epoch_ms, expires_at_epoch_ms
            ) VALUES (:id, :parentSessionId, :userId, :installationId, :tokenHash,
                :origin, 'desktop-ui-v1', :now, :expiresAt)
            """.trimIndent(),
        ).param("id", UUID.randomUUID()).param("parentSessionId", parentSessionId)
            .param("userId", parent.first).param("installationId", parent.second)
            .param("tokenHash", tokens.uiSessionHash(token)).param("origin", origin)
            .param("now", now).param("expiresAt", now + 60_000).update()
    }

    companion object {
        @Container
        @ServiceConnection
        @JvmStatic
        val postgres = PostgreSQLContainer("postgres:17-alpine")
    }
}
