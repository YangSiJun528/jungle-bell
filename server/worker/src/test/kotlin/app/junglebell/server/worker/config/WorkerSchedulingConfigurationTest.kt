package app.junglebell.server.worker.config

import org.springframework.boot.autoconfigure.AutoConfigurations
import org.springframework.boot.autoconfigure.task.TaskSchedulingAutoConfiguration
import org.springframework.boot.test.context.runner.ApplicationContextRunner
import org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotSame

class WorkerSchedulingConfigurationTest {
    private val contextRunner = ApplicationContextRunner()
        .withConfiguration(AutoConfigurations.of(TaskSchedulingAutoConfiguration::class.java))
        .withUserConfiguration(WorkerSchedulingConfiguration::class.java)

    @Test
    fun `push scheduling uses an executor isolated from collection jobs`() {
        contextRunner.run { context ->
            val defaultScheduler = context.getBean("taskScheduler", ThreadPoolTaskScheduler::class.java)
            val pushScheduler = context.getBean(PUSH_TASK_SCHEDULER_BEAN_NAME, ThreadPoolTaskScheduler::class.java)

            assertNotSame(defaultScheduler, pushScheduler)
            assertEquals("worker-scheduling-", defaultScheduler.threadNamePrefix)
            assertEquals("push-scheduling-", pushScheduler.threadNamePrefix)
        }
    }
}
