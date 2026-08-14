package app.junglebell.server.worker.config

import app.junglebell.server.common.config.JungleBellProperties
import app.junglebell.server.domain.automation.AutomationEngine
import app.junglebell.server.domain.automation.AutomationStore
import app.junglebell.server.domain.automation.PushSender
import app.junglebell.server.domain.notification.NotificationStore
import app.junglebell.server.domain.publicapi.PublicDataStore
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.http.client.JdkClientHttpRequestFactory
import org.springframework.web.client.RestClient
import java.net.http.HttpClient
import java.time.Clock
import java.time.Duration

@Configuration
class WorkerConfiguration {
    @Bean
    fun collectorRestClient(properties: JungleBellProperties): RestClient {
        val timeout = Duration.ofSeconds(properties.collectors.requestTimeoutSeconds)
        val client = HttpClient.newBuilder()
            .connectTimeout(timeout)
            .followRedirects(HttpClient.Redirect.NORMAL)
            .build()
        return RestClient.builder()
            .requestFactory(JdkClientHttpRequestFactory(client).also { it.setReadTimeout(timeout) })
            .defaultHeader("User-Agent", "JungleBellCollector/0.6")
            .build()
    }

    @Bean
    fun automationEngine(
        automation: AutomationStore,
        notifications: NotificationStore,
        publicData: PublicDataStore,
        pushSender: PushSender,
        clock: Clock,
    ) = AutomationEngine(automation, notifications, publicData, pushSender, clock)
}
