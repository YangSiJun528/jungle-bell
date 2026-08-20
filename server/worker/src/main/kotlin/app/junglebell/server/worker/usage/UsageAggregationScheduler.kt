package app.junglebell.server.worker.usage

import app.junglebell.server.domain.usage.UsageAggregationService
import app.junglebell.server.worker.logging.JobRunContext
import org.slf4j.LoggerFactory
import org.springframework.scheduling.annotation.Scheduled
import org.springframework.stereotype.Component

@Component
class UsageAggregationScheduler(private val service: UsageAggregationService) {
    private val logger = LoggerFactory.getLogger(javaClass)

    @Scheduled(initialDelay = 90_000, fixedDelay = 60 * 60_000)
    fun aggregate() = JobRunContext.run {
        logger.info("Usage aggregation job started.")
        try {
            val result = service.runHourly()
            if (result == null) {
                logger.info("Usage aggregation job skipped.")
            } else {
                logger.info(
                    "Usage aggregation job completed. rebuiltDays={} anonymousDeleted={} userActivityDeleted={} featureDeleted={} summaryDeleted={}",
                    result.rebuiltDays,
                    result.purge.anonymousRows,
                    result.purge.userActivityRows,
                    result.purge.featureRows,
                    result.purge.summaryRows,
                )
            }
        } catch (error: Exception) {
            logger.error("Usage aggregation job failed.", error)
        }
    }
}
