package app.junglebell.server.api

import app.junglebell.server.api.common.ApiErrorHandler
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import org.springframework.http.HttpMethod
import org.springframework.http.HttpStatus
import org.springframework.web.servlet.resource.NoResourceFoundException

class JungleBellApiApplicationTest {
    @Test
    fun applicationTypeExists() {
        assertNotNull(JungleBellApiApplication::class)
    }

    @Test
    fun `unknown API route returns not found instead of internal error`() {
        val response = ApiErrorHandler().notFound(
            NoResourceFoundException(HttpMethod.GET, "api/mobile/attendance", "/api/mobile/attendance"),
        )

        assertEquals(HttpStatus.NOT_FOUND, response.statusCode)
        assertEquals("NOT_FOUND", response.body?.error)
    }
}
