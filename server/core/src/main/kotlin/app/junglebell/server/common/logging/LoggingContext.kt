package app.junglebell.server.common.logging

import org.slf4j.MDC

object LoggingContext {
    const val REQUEST_ID = "requestId"
    const val JOB_RUN_ID = "jobRunId"

    fun <T> withRequest(requestId: String, operation: () -> T): T = withRootContext(REQUEST_ID, requestId, operation)

    fun <T> withJobRun(jobRunId: String, operation: () -> T): T = withRootContext(JOB_RUN_ID, jobRunId, operation)

    fun clearCorrelationIds() {
        MDC.remove(REQUEST_ID)
        MDC.remove("userId")
        MDC.remove(JOB_RUN_ID)
    }

    private fun <T> withRootContext(key: String, value: String, operation: () -> T): T {
        clearCorrelationIds()
        MDC.put(key, value)
        return try {
            operation()
        } finally {
            clearCorrelationIds()
        }
    }
}
