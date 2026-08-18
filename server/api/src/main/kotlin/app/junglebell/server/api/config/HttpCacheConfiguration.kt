package app.junglebell.server.api.config

import java.time.Duration
import org.springframework.context.annotation.Configuration
import org.springframework.http.CacheControl
import org.springframework.web.servlet.config.annotation.ResourceHandlerRegistry
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer

@Configuration
class HttpCacheConfiguration : WebMvcConfigurer {
    override fun addResourceHandlers(registry: ResourceHandlerRegistry) {
        registry.addResourceHandler("/assets/**")
            .addResourceLocations("classpath:/static/assets/")
            .setCacheControl(ONE_DAY_PUBLIC)

        registry.addResourceHandler("/icons/**")
            .addResourceLocations("classpath:/static/icons/")
            .setCacheControl(ONE_DAY_PUBLIC)

        registry.addResourceHandler("/index.html", "/sw.js")
            .addResourceLocations("classpath:/static/")
            .setCacheControl(CacheControl.noStore())
    }

    private companion object {
        val ONE_DAY_PUBLIC: CacheControl = CacheControl.maxAge(Duration.ofDays(1)).cachePublic()
    }
}
