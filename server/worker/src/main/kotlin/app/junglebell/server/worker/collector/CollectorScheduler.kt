package app.junglebell.server.worker.collector

import app.junglebell.server.common.config.JungleBellProperties
import app.junglebell.server.worker.logging.JobRunContext
import org.slf4j.LoggerFactory
import org.springframework.scheduling.annotation.Scheduled
import org.springframework.stereotype.Component

@Component
class CollectorScheduler(
    private val collector: CollectorService,
    private val properties: JungleBellProperties,
) {
    private val logger = LoggerFactory.getLogger(javaClass)

    @Scheduled(initialDelay = 5_000, fixedDelay = 60_000)
    fun collectLaundry() = JobRunContext.run {
        if (!properties.collectors.enabled) {
            logger.debug("Laundry collection job skipped. reason=collectors_disabled")
            return@run
        }
        if (properties.collectors.laundryUrl == null) {
            logger.debug("Laundry collection job skipped. reason=source_url_not_configured")
            return@run
        }
        logger.info("Laundry collection job started.")
        try {
            collector.collectLaundry()
            logger.info("Laundry collection job completed.")
        } catch (error: Exception) {
            logger.error("Laundry collection job failed.", error)
        }
    }

    @Scheduled(initialDelay = 10_000, fixedDelay = 300_000)
    fun collectMeals() = JobRunContext.run {
        if (!properties.collectors.enabled) {
            logger.debug("Meal collection job skipped. reason=collectors_disabled")
            return@run
        }
        if (properties.collectors.mealsPinnedUrl == null && properties.collectors.mealsDefaultUrl == null) {
            logger.debug("Meal collection job skipped. reason=source_urls_not_configured")
            return@run
        }
        logger.info("Meal collection job started.")
        try {
            collector.collectMeals()
            logger.info("Meal collection job completed.")
        } catch (error: Exception) {
            logger.error("Meal collection job failed.", error)
        }
    }
}
