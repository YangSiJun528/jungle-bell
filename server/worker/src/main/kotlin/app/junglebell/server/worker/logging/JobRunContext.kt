package app.junglebell.server.worker.logging

import app.junglebell.server.common.logging.LoggingContext
import java.util.UUID

object JobRunContext {
    fun <T> run(operation: () -> T): T = LoggingContext.withJobRun(UUID.randomUUID().toString(), operation)
}
