package app.junglebell.server.api.config

import java.time.Duration
import org.springframework.core.io.ClassPathResource
import org.springframework.http.CacheControl
import org.springframework.http.MediaType
import org.springframework.http.ResponseEntity
import org.slf4j.LoggerFactory
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RestController

@RestController
class WebManifestController {
    private val logger = LoggerFactory.getLogger(javaClass)

    @GetMapping("/manifest.webmanifest", produces = [WEB_MANIFEST])
    fun manifest(): ResponseEntity<ClassPathResource> {
        logger.debug("Web manifest request received.")
        val response = ResponseEntity.ok()
            .cacheControl(CacheControl.maxAge(Duration.ofHours(1)).cachePublic())
            .contentType(MediaType.parseMediaType(WEB_MANIFEST))
            .body(ClassPathResource("static/manifest.webmanifest"))
        logger.debug("Web manifest request completed. status=200")
        return response
    }

    private companion object {
        const val WEB_MANIFEST = "application/manifest+json"
    }
}
