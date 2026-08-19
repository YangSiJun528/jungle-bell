package app.junglebell.server.worker.automation

import app.junglebell.server.domain.automation.AutomationEngine
import app.junglebell.server.worker.logging.JobRunContext
import org.slf4j.LoggerFactory
import org.springframework.scheduling.annotation.Scheduled
import org.springframework.stereotype.Component

@Component
class AutomationScheduler(private val engine: AutomationEngine) {
    private val logger = LoggerFactory.getLogger(javaClass)

    @Scheduled(initialDelay = 20_000, fixedDelay = 60_000)
    fun runMinuteCycle() = JobRunContext.run {
        logger.info("Minute automation job started.")
        try {
            engine.runMinuteCycle()
            logger.info("Minute automation job completed.")
        } catch (error: Exception) {
            logger.error("Minute automation job failed.", error)
        }
    }

    @Scheduled(initialDelay = 60_000, fixedDelay = 60 * 60_000)
    fun runHousekeeping() = JobRunContext.run {
        logger.info("Housekeeping job started.")
        try {
            engine.runHousekeeping()
            logger.info("Housekeeping job completed.")
        } catch (error: Exception) {
            logger.error("Housekeeping job failed.", error)
        }
    }
}
