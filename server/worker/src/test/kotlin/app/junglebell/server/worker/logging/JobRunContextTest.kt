package app.junglebell.server.worker.logging

import app.junglebell.server.common.logging.LoggingContext
import java.util.UUID
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertFailsWith
import kotlin.test.assertNotEquals
import kotlin.test.assertNull
import org.slf4j.MDC

class JobRunContextTest {
    @AfterTest
    fun clearMdc() {
        LoggingContext.clearCorrelationIds()
    }

    @Test
    fun `each job invocation receives a distinct UUID and clears it afterward`() {
        var first: String? = null
        var second: String? = null

        JobRunContext.run {
            first = MDC.get(LoggingContext.JOB_RUN_ID)
            UUID.fromString(first)
            assertNull(MDC.get(LoggingContext.REQUEST_ID))
            assertNull(MDC.get(LoggingContext.USER_ID))
        }
        JobRunContext.run {
            second = MDC.get(LoggingContext.JOB_RUN_ID)
            UUID.fromString(second)
        }

        assertNotEquals(first, second)
        assertNull(MDC.get(LoggingContext.JOB_RUN_ID))
    }

    @Test
    fun `job run identifier is cleared when a job fails`() {
        assertFailsWith<IllegalStateException> {
            JobRunContext.run { throw IllegalStateException("failed") }
        }

        assertNull(MDC.get(LoggingContext.JOB_RUN_ID))
    }
}
