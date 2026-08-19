package app.junglebell.server.common.logging

import org.slf4j.MDC

object LoggingContext {
    const val REQUEST_ID = "requestId"
    const val USER_ID = "userId"
    const val JOB_RUN_ID = "jobRunId"

    fun <T> withRequest(requestId: String, operation: () -> T): T = withRootContext(REQUEST_ID, requestId, operation)

    fun <T> withJobRun(jobRunId: String, operation: () -> T): T = withRootContext(JOB_RUN_ID, jobRunId, operation)

    fun <T> withUser(userId: String, operation: () -> T): T {
        val previous = MDC.get(USER_ID)
        MDC.put(USER_ID, userId)
        return try {
            operation()
        } finally {
            if (previous == null) MDC.remove(USER_ID) else MDC.put(USER_ID, previous)
        }
    }

    fun clearCorrelationIds() {
        MDC.remove(REQUEST_ID)
        MDC.remove(USER_ID)
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
