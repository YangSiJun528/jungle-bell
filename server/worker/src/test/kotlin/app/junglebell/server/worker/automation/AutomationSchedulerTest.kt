package app.junglebell.server.worker.automation

import app.junglebell.server.domain.automation.AutomationEngine
import app.junglebell.server.worker.config.PUSH_TASK_SCHEDULER_BEAN_NAME
import org.mockito.Mockito.mock
import org.mockito.Mockito.verify
import org.springframework.scheduling.annotation.Scheduled
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull

class AutomationSchedulerTest {
    @Test
    fun `push delivery uses a dedicated five second schedule`() {
        val scheduled = AutomationScheduler::class.java
            .getDeclaredMethod("runPushCycle")
            .getAnnotation(Scheduled::class.java)

        assertNotNull(scheduled)
        assertEquals(PUSH_INITIAL_DELAY_MILLIS, scheduled.initialDelay)
        assertEquals(PUSH_POLL_INTERVAL_MILLIS, scheduled.fixedDelay)
        assertEquals(PUSH_TASK_SCHEDULER_BEAN_NAME, scheduled.scheduler)
    }

    @Test
    fun `push delivery invokes the independent engine cycle`() {
        val engine = mock(AutomationEngine::class.java)

        AutomationScheduler(engine).runPushCycle()

        verify(engine).runPushCycle()
    }
}
