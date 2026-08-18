package app.junglebell.server.api.config

import java.time.Duration
import org.springframework.core.io.ClassPathResource
import org.springframework.http.CacheControl
import org.springframework.http.MediaType
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RestController

@RestController
class WebManifestController {
    @GetMapping("/manifest.webmanifest", produces = [WEB_MANIFEST])
    fun manifest(): ResponseEntity<ClassPathResource> = ResponseEntity.ok()
        .cacheControl(CacheControl.maxAge(Duration.ofHours(1)).cachePublic())
        .contentType(MediaType.parseMediaType(WEB_MANIFEST))
        .body(ClassPathResource("static/manifest.webmanifest"))

    private companion object {
        const val WEB_MANIFEST = "application/manifest+json"
    }
}
