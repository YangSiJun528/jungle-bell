package app.junglebell.server.worker.collector

import app.junglebell.server.common.config.JungleBellProperties
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
    fun collectLaundry() {
        if (!properties.collectors.enabled || properties.collectors.laundryUrl == null) return
        runCatching(collector::collectLaundry).onFailure { logger.error("Laundry collection failed", it) }
    }

    @Scheduled(initialDelay = 10_000, fixedDelay = 300_000)
    fun collectMeals() {
        if (!properties.collectors.enabled) return
        runCatching(collector::collectMeals).onFailure { logger.error("Meal collection failed", it) }
    }
}
