package app.junglebell.server.api.security

import app.junglebell.server.domain.security.TokenCodec
import app.junglebell.server.api.logging.REQUEST_ID_HEADER
import jakarta.servlet.http.Cookie
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import java.util.UUID
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.beans.factory.annotation.Value
import org.springframework.boot.health.actuate.endpoint.HealthEndpointGroups
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.test.web.server.LocalServerPort
import org.springframework.boot.testcontainers.service.connection.ServiceConnection
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc
import org.springframework.http.HttpHeaders
import org.springframework.http.HttpMethod
import org.springframework.http.MediaType
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.options
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put
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
@SpringBootTest(
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = ["management.server.port=0"],
)
class SecurityFilterChainIntegrationTest(
    @param:Autowired private val mockMvc: MockMvc,
    @param:Autowired private val jdbc: JdbcClient,
    @param:Autowired private val tokens: TokenCodec,
    @param:Autowired private val healthEndpointGroups: HealthEndpointGroups,
    @param:LocalServerPort private val applicationPort: Int,
    @param:Value("\${local.management.port}") private val managementPort: Int,
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
    fun `actuator is isolated from the application port and exposes only health and info`() {
        assertTrue(assertNotNull(healthEndpointGroups.get("readiness")).isMember("db"))
        assertNotEquals(applicationPort, managementPort)

        listOf(
            "/actuator",
            "/actuator/health",
            "/actuator/health/readiness",
            "/actuator/info",
            "/actuator/prometheus",
        ).forEach { path ->
            assertEquals(404, httpGet(applicationPort, path).statusCode(), path)
        }

        val readiness = httpGet(managementPort, "/actuator/health/readiness")
        assertEquals(200, readiness.statusCode())
        assertTrue(readiness.body().contains("\"status\":\"UP\""))

        val info = httpGet(managementPort, "/actuator/info")
        assertEquals(200, info.statusCode())
        assertTrue(info.body().contains("\"configured\":true"))
        assertTrue(info.body().contains("\"database\":\"available\""))
        assertTrue(info.body().contains("\"aggregation\":"))
        assertFalse(info.body().contains("counts"))
        assertFalse(info.body().contains("userIds"))
        assertFalse(info.body().contains("rawRecency"))

        assertEquals(404, httpGet(managementPort, "/actuator/prometheus").statusCode())
    }

    @Test
    fun `missing credentials return the API authentication error`() {
        mockMvc.perform(get("/api/me/session"))
            .andExpect(status().isUnauthorized)
            .andExpect(header().exists(REQUEST_ID_HEADER))
            .andExpect(jsonPath("$.error").value("AUTHENTICATION_REQUIRED"))
    }

    @Test
    fun `safe client request id is returned on a security failure`() {
        mockMvc.perform(get("/api/me/session").header(REQUEST_ID_HEADER, "security-test-1"))
            .andExpect(status().isUnauthorized)
            .andExpect(header().string(REQUEST_ID_HEADER, "security-test-1"))
    }

    @Test
    fun `desktop webview origin can read public API responses`() {
        mockMvc.perform(
            get("/api/public/status")
                .header(HttpHeaders.ORIGIN, "tauri://localhost"),
        ).andExpect(status().isOk)
            .andExpect(header().string(HttpHeaders.ACCESS_CONTROL_ALLOW_ORIGIN, "tauri://localhost"))
            .andExpect(
                header().string(
                    HttpHeaders.ACCESS_CONTROL_EXPOSE_HEADERS,
                    org.hamcrest.Matchers.containsString(REQUEST_ID_HEADER),
                ),
            )
    }

    @Test
    fun `desktop webview origin can send the request id header`() {
        mockMvc.perform(
            options("/api/public/status")
                .header(HttpHeaders.ORIGIN, "tauri://localhost")
                .header(HttpHeaders.ACCESS_CONTROL_REQUEST_METHOD, HttpMethod.GET.name())
                .header(HttpHeaders.ACCESS_CONTROL_REQUEST_HEADERS, REQUEST_ID_HEADER),
        ).andExpect(status().isOk)
            .andExpect(
                header().string(
                    HttpHeaders.ACCESS_CONTROL_ALLOW_HEADERS,
                    org.hamcrest.Matchers.containsString(REQUEST_ID_HEADER),
                ),
            )
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
    fun `desktop and mobile sessions can report a UI open without choosing their client`() {
        val desktopToken = "jbd_" + "1".repeat(64)
        val mobileToken = "jbs_" + "2".repeat(64)
        val desktopSession = createAppSession("desktop", desktopToken)
        val mobileSession = createAppSession("mobile", mobileToken)

        mockMvc.perform(
            post("/api/me/usage/ui-opened")
                .header(HttpHeaders.AUTHORIZATION, "Bearer $desktopToken"),
        ).andExpect(status().isNoContent)
        mockMvc.perform(
            post("/api/me/usage/ui-opened")
                .cookie(Cookie("jb_device", mobileToken)),
        ).andExpect(status().isNoContent)

        assertUsageClient(desktopSession, "desktop")
        assertUsageClient(mobileSession, "pwa")
    }

    @Test
    fun `existing account remains untracked until usage preference is enabled`() {
        val token = "jbs_" + "4".repeat(64)
        val sessionId = createAppSession("mobile", token, usageEnabled = null)
        val userId = sessionUserId(sessionId)
        val desktopToken = "jbd_" + "5".repeat(64)
        createAppSession("desktop", desktopToken, existingUserId = userId)

        mockMvc.perform(get("/api/me/usage-preference").cookie(Cookie("jb_device", token)))
            .andExpect(status().isOk)
            .andExpect(jsonPath("$.enabled").value(org.hamcrest.Matchers.nullValue()))
        mockMvc.perform(post("/api/me/usage/ui-opened").cookie(Cookie("jb_device", token)))
            .andExpect(status().isNoContent)
        assertUsageCount(sessionId, 0)

        mockMvc.perform(
            put("/api/desktop/usage-preference")
                .header(HttpHeaders.AUTHORIZATION, "Bearer $desktopToken")
                .contentType(MediaType.APPLICATION_JSON)
                .content("""{"enabled":true}"""),
        ).andExpect(status().isOk)
            .andExpect(jsonPath("$.enabled").value(true))
        mockMvc.perform(post("/api/me/usage/ui-opened").cookie(Cookie("jb_device", token)))
            .andExpect(status().isNoContent)
        assertUsageCount(sessionId, 1)

        mockMvc.perform(
            put("/api/desktop/usage-preference")
                .header(HttpHeaders.AUTHORIZATION, "Bearer $desktopToken")
                .contentType(MediaType.APPLICATION_JSON)
                .content("""{"enabled":false}"""),
        ).andExpect(status().isOk)
            .andExpect(jsonPath("$.enabled").value(false))
    }

    @Test
    fun `explicitly disabled account receives 204 without storing usage`() {
        val token = "jbs_" + "7".repeat(64)
        val sessionId = createAppSession("mobile", token, usageEnabled = false)

        mockMvc.perform(post("/api/me/usage/ui-opened").cookie(Cookie("jb_device", token)))
            .andExpect(status().isNoContent)

        assertUsageCount(sessionId, 0)
    }

    @Test
    fun `desktop bearer controls the shared usage preference and mobile can read it`() {
        val desktopToken = "jbd_" + "9".repeat(64)
        val desktopSessionId = createAppSession("desktop", desktopToken)
        val userId = sessionUserId(desktopSessionId)
        val mobileToken = "jbs_" + "6".repeat(64)
        createAppSession("mobile", mobileToken, existingUserId = userId)

        mockMvc.perform(
            put("/api/desktop/usage-preference")
                .header(HttpHeaders.AUTHORIZATION, "Bearer $desktopToken")
                .contentType(MediaType.APPLICATION_JSON)
                .content("""{"enabled":false}"""),
        ).andExpect(status().isOk)
            .andExpect(jsonPath("$.enabled").value(false))
        mockMvc.perform(
            get("/api/me/usage-preference")
                .cookie(Cookie("jb_device", mobileToken)),
        ).andExpect(status().isOk)
            .andExpect(jsonPath("$.enabled").value(false))

        mockMvc.perform(
            put("/api/me/usage-preference")
                .cookie(Cookie("jb_device", mobileToken))
                .contentType(MediaType.APPLICATION_JSON)
                .content("""{"enabled":true}"""),
        ).andExpect(status().isForbidden)
            .andExpect(jsonPath("$.error").value("SESSION_KIND_DENIED"))
        mockMvc.perform(
            get("/api/desktop/usage-preference")
                .header(HttpHeaders.AUTHORIZATION, "Bearer $desktopToken"),
        ).andExpect(status().isOk)
            .andExpect(jsonPath("$.enabled").value(false))
    }

    @Test
    fun `anonymous UI open issues a short lived first party visitor cookie`() {
        val result = mockMvc.perform(
            post("/api/public/usage/ui-opened")
                .header("X-Forwarded-Proto", "https")
                .contentType(MediaType.APPLICATION_JSON)
                .content("""{"client":"web"}"""),
        ).andExpect(status().isNoContent)
            .andExpect(header().string(HttpHeaders.SET_COOKIE, org.hamcrest.Matchers.containsString("__Host-jb_usage=jbv_")))
            .andExpect(header().string(HttpHeaders.SET_COOKIE, org.hamcrest.Matchers.containsString("Max-Age=86400")))
            .andExpect(header().string(HttpHeaders.SET_COOKIE, org.hamcrest.Matchers.containsString("HttpOnly")))
            .andExpect(header().string(HttpHeaders.SET_COOKIE, org.hamcrest.Matchers.containsString("Secure")))
            .andExpect(header().string(HttpHeaders.SET_COOKIE, org.hamcrest.Matchers.containsString("SameSite=Strict")))
            .andReturn()

        val token = result.response.getHeader(HttpHeaders.SET_COOKIE)!!
            .substringAfter("jb_usage=").substringBefore(';')
        mockMvc.perform(
            post("/api/public/usage/ui-opened")
                .header("X-Forwarded-Proto", "https")
                .cookie(Cookie("__Host-jb_usage", token))
                .contentType(MediaType.APPLICATION_JSON)
                .content("""{"client":"web"}"""),
        ).andExpect(status().isNoContent)
            .andExpect(header().doesNotExist(HttpHeaders.SET_COOKIE))

        kotlin.test.assertEquals(
            1,
            jdbc.sql("SELECT count(*) FROM usage_anonymous_day WHERE client = 'web'")
                .query(Int::class.java).single(),
        )
    }

    @Test
    fun `anonymous opt out cookie blocks collection and clears the visitor cookie`() {
        val before = jdbc.sql("SELECT count(*) FROM usage_anonymous_day")
            .query(Int::class.java).single()
        mockMvc.perform(get("/api/public/usage-preference"))
            .andExpect(status().isOk)
            .andExpect(header().string(HttpHeaders.CACHE_CONTROL, "no-store"))
            .andExpect(jsonPath("$.enabled").value(true))
        val disabled = mockMvc.perform(
            put("/api/public/usage-preference")
                .header("X-Forwarded-Proto", "https")
                .contentType(MediaType.APPLICATION_JSON)
                .content("""{"enabled":false}"""),
        ).andExpect(status().isOk)
            .andExpect(header().string(HttpHeaders.CACHE_CONTROL, "no-store"))
            .andExpect(jsonPath("$.enabled").value(false))
            .andReturn()

        val disabledCookies = disabled.response.getHeaders(HttpHeaders.SET_COOKIE)
        kotlin.test.assertTrue(
            disabledCookies.any {
                it.contains("__Host-jb_usage_opt_out=1") &&
                    it.contains("Max-Age=31536000") && it.contains("HttpOnly") &&
                    it.contains("Secure") && it.contains("SameSite=Strict")
            },
        )
        kotlin.test.assertTrue(
            disabledCookies.any { it.startsWith("jb_usage=;") && it.contains("Max-Age=0") },
        )
        kotlin.test.assertTrue(
            disabledCookies.any { it.startsWith("__Host-jb_usage=;") && it.contains("Max-Age=0") },
        )

        mockMvc.perform(
            get("/api/public/usage-preference")
                .header("X-Forwarded-Proto", "https")
                .cookie(Cookie("__Host-jb_usage_opt_out", "corrupt")),
        ).andExpect(status().isOk)
            .andExpect(header().string(HttpHeaders.CACHE_CONTROL, "no-store"))
            .andExpect(jsonPath("$.enabled").value(false))
        mockMvc.perform(
            post("/api/public/usage/ui-opened")
                .header("X-Forwarded-Proto", "https")
                .cookie(
                    Cookie("__Host-jb_usage_opt_out", "1"),
                    Cookie("__Host-jb_usage", "jbv_${"f".repeat(64)}"),
                )
                .contentType(MediaType.APPLICATION_JSON)
                .content("""{"client":"web"}"""),
        ).andExpect(status().isNoContent)
            .andExpect(header().doesNotExist(HttpHeaders.SET_COOKIE))
        kotlin.test.assertEquals(
            before,
            jdbc.sql("SELECT count(*) FROM usage_anonymous_day").query(Int::class.java).single(),
        )

        val enabled = mockMvc.perform(
            put("/api/public/usage-preference")
                .header("X-Forwarded-Proto", "https")
                .cookie(Cookie("__Host-jb_usage_opt_out", "1"))
                .contentType(MediaType.APPLICATION_JSON)
                .content("""{"enabled":true}"""),
        ).andExpect(status().isOk)
            .andExpect(header().string(HttpHeaders.CACHE_CONTROL, "no-store"))
            .andExpect(jsonPath("$.enabled").value(true))
            .andReturn()
        kotlin.test.assertTrue(
            enabled.response.getHeaders(HttpHeaders.SET_COOKIE).any {
                it.startsWith("__Host-jb_usage_opt_out=;") && it.contains("Max-Age=0")
            },
        )
        kotlin.test.assertTrue(
            enabled.response.getHeaders(HttpHeaders.SET_COOKIE).any {
                it.startsWith("jb_usage_opt_out=;") && it.contains("Max-Age=0")
            },
        )

        val insecure = mockMvc.perform(
            put("/api/public/usage-preference")
                .contentType(MediaType.APPLICATION_JSON)
                .content("""{"enabled":false}"""),
        ).andExpect(status().isOk)
            .andReturn()
        kotlin.test.assertTrue(
            insecure.response.getHeaders(HttpHeaders.SET_COOKIE).any {
                it.startsWith("jb_usage_opt_out=1;") && !it.contains("Secure")
            },
        )
        kotlin.test.assertTrue(
            insecure.response.getHeaders(HttpHeaders.SET_COOKIE).none {
                it.startsWith("__Host-jb_usage_opt_out=")
            },
        )
    }

    @Test
    fun `feature usage is recorded only after an allowlisted server operation succeeds`() {
        val token = "jbs_" + "3".repeat(64)
        val sessionId = createAppSession("mobile", token)
        val valid = """
            {
              "enabled": true,
              "morning": true,
              "evening": true,
              "morningStartHour": 8,
              "eveningEndHour": 4,
              "morningIntervalMinutes": 15,
              "eveningIntervalMinutes": 15,
              "skipSunday": false,
              "skipAttendanceDate": null
            }
        """.trimIndent()
        mockMvc.perform(
            put("/api/me/attendance/preferences")
                .cookie(Cookie("jb_device", token))
                .contentType(MediaType.APPLICATION_JSON)
                .content(valid),
        ).andExpect(status().isOk)

        val invalid = valid.replace("\"morningIntervalMinutes\": 15", "\"morningIntervalMinutes\": 2")
        mockMvc.perform(
            put("/api/me/attendance/preferences")
                .cookie(Cookie("jb_device", token))
                .contentType(MediaType.APPLICATION_JSON)
                .content(invalid),
        ).andExpect(status().isBadRequest)

        val count = jdbc.sql(
            """
            SELECT usage.use_count
            FROM usage_feature_day usage
            JOIN app_session session ON session.user_id = usage.user_id
            WHERE session.id = :sessionId AND usage.client = 'pwa'
              AND usage.feature_code = 'attendance_settings_changed'
            """.trimIndent(),
        ).param("sessionId", sessionId).query(Long::class.java).single()
        kotlin.test.assertEquals(1L, count)
    }

    @Test
    fun `desktop identity deletion invalidates its bearer and removes the account`() {
        val token = "jbd_" + "f".repeat(64)
        val sessionId = createAppSession("desktop", token)
        val userId = jdbc.sql("SELECT user_id FROM app_session WHERE id = :id")
            .param("id", sessionId).query(UUID::class.java).single()
        val mobileToken = "jbs_" + "8".repeat(64)
        val now = System.currentTimeMillis()
        jdbc.sql(
            """
            INSERT INTO app_session(
                id, user_id, installation_id, kind, label, token_sha256,
                created_at_epoch_ms, expires_at_epoch_ms, last_seen_at_epoch_ms,
                revoked_at_epoch_ms, source_pairing_id
            ) VALUES (:id, :userId, :installationId, 'mobile', 'reset test mobile', :tokenHash,
                :now, :expiresAt, :now, NULL, NULL)
            """.trimIndent(),
        ).param("id", UUID.randomUUID()).param("userId", userId)
            .param("installationId", "mobile-${UUID.randomUUID()}")
            .param("tokenHash", tokens.sessionHash(mobileToken))
            .param("now", now).param("expiresAt", now + 60_000).update()

        mockMvc.perform(get("/api/me/session").cookie(Cookie("jb_device", mobileToken)))
            .andExpect(status().isOk)

        mockMvc.perform(
            delete("/api/desktop/installations/current")
                .header(HttpHeaders.AUTHORIZATION, "Bearer $token"),
        ).andExpect(status().isNoContent)

        mockMvc.perform(
            get("/api/desktop/attendance")
                .header(HttpHeaders.AUTHORIZATION, "Bearer $token"),
        ).andExpect(status().isUnauthorized)
        mockMvc.perform(get("/api/me/session").cookie(Cookie("jb_device", mobileToken)))
            .andExpect(status().isUnauthorized)
        kotlin.test.assertEquals(
            0,
            jdbc.sql("SELECT count(*) FROM app_user WHERE id = :id")
                .param("id", userId).query(Int::class.java).single(),
        )
    }

    @Test
    fun `mobile bearer cannot delete a desktop identity`() {
        val token = "jbs_" + "9".repeat(64)
        createAppSession("mobile", token)

        mockMvc.perform(
            delete("/api/desktop/installations/current")
                .header(HttpHeaders.AUTHORIZATION, "Bearer $token"),
        ).andExpect(status().isForbidden)
            .andExpect(jsonPath("$.error").value("SESSION_KIND_DENIED"))
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

    private fun createAppSession(
        kind: String,
        token: String,
        usageEnabled: Boolean? = true,
        existingUserId: UUID? = null,
    ): UUID {
        val userId = existingUserId ?: UUID.randomUUID()
        val sessionId = UUID.randomUUID()
        val installationId = "$kind-${UUID.randomUUID()}"
        val now = System.currentTimeMillis()
        if (existingUserId == null) {
            jdbc.sql("INSERT INTO app_user(id, created_at_epoch_ms) VALUES (:userId, :now)")
                .param("userId", userId).param("now", now).update()
            if (usageEnabled != null) {
                jdbc.sql(
                    "INSERT INTO usage_preference(user_id, enabled, updated_at_epoch_ms) " +
                        "VALUES (:userId, :enabled, :now)",
                ).param("userId", userId).param("enabled", usageEnabled).param("now", now).update()
            }
        }
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
            ) VALUES (:id, :userId, :installationId, :kind, 'test device', :tokenHash,
                :now, :expiresAt, :now, NULL, NULL)
            """.trimIndent(),
        ).param("id", sessionId).param("userId", userId).param("installationId", installationId)
            .param("kind", kind).param("tokenHash", tokens.sessionHash(token))
            .param("now", now).param("expiresAt", now + 60_000).update()
        return sessionId
    }

    private fun sessionUserId(sessionId: UUID): UUID = jdbc.sql(
        "SELECT user_id FROM app_session WHERE id = :sessionId",
    ).param("sessionId", sessionId).query(UUID::class.java).single()

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

    private fun assertUsageClient(sessionId: UUID, client: String) {
        val count = jdbc.sql(
            """
            SELECT count(*)
            FROM usage_user_day usage
            JOIN app_session session ON session.user_id = usage.user_id
            WHERE session.id = :sessionId AND usage.client = :client AND usage.activity = 'ui_opened'
            """.trimIndent(),
        ).param("sessionId", sessionId).param("client", client).query(Int::class.java).single()
        kotlin.test.assertEquals(1, count)
    }

    private fun assertUsageCount(sessionId: UUID, expected: Int) {
        val count = jdbc.sql(
            """
            SELECT count(*)
            FROM usage_user_day usage
            JOIN app_session session ON session.user_id = usage.user_id
            WHERE session.id = :sessionId
            """.trimIndent(),
        ).param("sessionId", sessionId).query(Int::class.java).single()
        kotlin.test.assertEquals(expected, count)
    }

    private fun httpGet(port: Int, path: String): HttpResponse<String> = httpClient.send(
        HttpRequest.newBuilder(URI.create("http://127.0.0.1:$port$path"))
            .timeout(Duration.ofSeconds(5))
            .GET()
            .build(),
        HttpResponse.BodyHandlers.ofString(),
    )

    companion object {
        private val httpClient: HttpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(5))
            .build()

        @Container
        @ServiceConnection
        @JvmStatic
        val postgres = PostgreSQLContainer("postgres:17-alpine")
    }
}
