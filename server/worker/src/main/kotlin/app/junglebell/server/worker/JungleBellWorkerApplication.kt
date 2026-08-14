package app.junglebell.server.worker

import org.springframework.boot.WebApplicationType
import org.springframework.boot.autoconfigure.SpringBootApplication
import org.springframework.boot.builder.SpringApplicationBuilder
import org.springframework.boot.context.properties.ConfigurationPropertiesScan
import org.springframework.scheduling.annotation.EnableScheduling

@EnableScheduling
@ConfigurationPropertiesScan(basePackages = ["app.junglebell.server.common.config"])
@SpringBootApplication(scanBasePackages = ["app.junglebell.server"])
class JungleBellWorkerApplication

fun main(args: Array<String>) {
    SpringApplicationBuilder(JungleBellWorkerApplication::class.java)
        .web(WebApplicationType.NONE)
        .run(*args)
}
