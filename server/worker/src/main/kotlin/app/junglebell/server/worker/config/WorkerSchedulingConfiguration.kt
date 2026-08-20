package app.junglebell.server.worker.config

import org.springframework.boot.task.ThreadPoolTaskSchedulerBuilder
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler

internal const val PUSH_TASK_SCHEDULER_BEAN_NAME = "pushTaskScheduler"
private const val DEFAULT_TASK_SCHEDULER_BEAN_NAME = "taskScheduler"

@Configuration
class WorkerSchedulingConfiguration {
    @Bean(name = [DEFAULT_TASK_SCHEDULER_BEAN_NAME])
    fun taskScheduler(builder: ThreadPoolTaskSchedulerBuilder): ThreadPoolTaskScheduler =
        builder
            .poolSize(1)
            .threadNamePrefix("worker-scheduling-")
            .build()

    @Bean(name = [PUSH_TASK_SCHEDULER_BEAN_NAME])
    fun pushTaskScheduler(builder: ThreadPoolTaskSchedulerBuilder): ThreadPoolTaskScheduler =
        builder
            .poolSize(1)
            .threadNamePrefix("push-scheduling-")
            .build()
}
