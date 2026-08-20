package app.junglebell.server.common.logging

import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import org.slf4j.MDC

class LoggingContextTest {
    @AfterTest
    fun clearMdc() {
        LoggingContext.clearCorrelationIds()
    }

    @Test
    fun `request context controls and clears correlation identifiers`() {
        MDC.put("userId", "stale-user")
        MDC.put(LoggingContext.JOB_RUN_ID, "stale-job")

        LoggingContext.withRequest("request-1") {
            assertEquals("request-1", MDC.get(LoggingContext.REQUEST_ID))
            assertNull(MDC.get("userId"))
            assertNull(MDC.get(LoggingContext.JOB_RUN_ID))
        }

        assertNull(MDC.get(LoggingContext.REQUEST_ID))
        assertNull(MDC.get("userId"))
        assertNull(MDC.get(LoggingContext.JOB_RUN_ID))
    }

    @Test
    fun `root context is cleared when an operation fails`() {
        assertFailsWith<IllegalStateException> {
            LoggingContext.withJobRun("job-1") {
                throw IllegalStateException("failed")
            }
        }

        assertNull(MDC.get(LoggingContext.REQUEST_ID))
        assertNull(MDC.get("userId"))
        assertNull(MDC.get(LoggingContext.JOB_RUN_ID))
    }
}
