package app.junglebell.server.api

import org.springframework.boot.autoconfigure.SpringBootApplication
import org.springframework.boot.context.properties.ConfigurationPropertiesScan
import org.springframework.boot.runApplication

@ConfigurationPropertiesScan(basePackages = ["app.junglebell.server.common.config"])
@SpringBootApplication(scanBasePackages = ["app.junglebell.server"])
class JungleBellApiApplication

fun main(args: Array<String>) {
    runApplication<JungleBellApiApplication>(*args)
}
