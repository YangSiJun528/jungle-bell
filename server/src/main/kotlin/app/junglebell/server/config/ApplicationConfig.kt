package app.junglebell.server.config

import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.http.client.JdkClientHttpRequestFactory
import org.springframework.web.client.RestClient
import java.net.http.HttpClient
import java.time.Clock
import java.time.Duration

@Configuration
class ApplicationConfig {
    @Bean
    fun clock(): Clock = Clock.systemUTC()

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
}
