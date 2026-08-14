package app.junglebell.server.worker.automation

import app.junglebell.server.domain.automation.AutomationEngine
import org.springframework.scheduling.annotation.Scheduled
import org.springframework.stereotype.Component

@Component
class AutomationScheduler(private val engine: AutomationEngine) {
    @Scheduled(initialDelay = 20_000, fixedDelay = 60_000)
    fun runMinuteCycle() = engine.runMinuteCycle()

    @Scheduled(initialDelay = 60_000, fixedDelay = 60 * 60_000)
    fun runHousekeeping() = engine.runHousekeeping()
}
