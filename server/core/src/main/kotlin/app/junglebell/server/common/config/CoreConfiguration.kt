package app.junglebell.server.common.config

import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import java.time.Clock

@Configuration
class CoreConfiguration {
    @Bean
    fun clock(): Clock = Clock.systemUTC()
}
