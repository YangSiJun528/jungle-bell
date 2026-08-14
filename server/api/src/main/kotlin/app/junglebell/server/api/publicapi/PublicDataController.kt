package app.junglebell.server.api.publicapi

import app.junglebell.server.domain.publicapi.*
import jakarta.validation.constraints.Max
import jakarta.validation.constraints.Min
import org.springframework.http.CacheControl
import org.springframework.http.HttpHeaders
import org.springframework.http.HttpStatus
import org.springframework.http.MediaType
import org.springframework.http.ResponseEntity
import org.springframework.validation.annotation.Validated
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController
import org.springframework.web.servlet.view.RedirectView
import java.net.URI
import java.time.Instant
import java.util.concurrent.TimeUnit

@Validated
@RestController
class PublicDataController(private val service: PublicDataService) {
    private val latestCache = "public, max-age=15, s-maxage=30, stale-while-revalidate=120"
    private val immutableCache = "public, max-age=31536000, immutable"

    @GetMapping("/")
    fun root(): ResponseEntity<Void> = ResponseEntity.status(308).location(URI.create("/dashboard.html")).build()

    @GetMapping("/blog", "/blog/")
    fun blog(): ResponseEntity<Void> = ResponseEntity.status(308).location(URI.create("/blog/index.html")).build()

    @GetMapping("/api/health")
    fun health(): ResponseEntity<PublicHealth> {
        val (body, status) = service.health()
        return ResponseEntity.status(status).body(body)
    }

    @GetMapping("/api/public/status")
    fun status() = latest(service.status())

    @GetMapping("/api/public/laundry/head")
    fun laundryHead() = latest(service.laundryHead())

    @GetMapping("/api/public/laundry")
    fun laundry() = latest(service.laundry())

    @GetMapping("/api/public/laundry/at")
    fun laundryAt(@RequestParam time: String): ResponseEntity<Void> {
        val instant = Instant.parse(time)
        return ResponseEntity.status(308)
            .location(URI.create("/api/public/laundry/minutes/${service.compactMinute(instant)}"))
            .header(HttpHeaders.CACHE_CONTROL, immutableCache)
            .build()
    }

    @GetMapping("/api/public/laundry/minutes/{minute}")
    fun laundryMinute(@PathVariable minute: String) = immutable(service.laundryAt(minute))

    @GetMapping("/api/public/laundry/versions/{sha}")
    fun laundryVersion(@PathVariable sha: String): ResponseEntity<LaundryVersion> {
        require(sha.matches(Regex("^[a-f0-9]{64}$")))
        return immutable(service.laundryVersion(sha))
    }

    @GetMapping("/api/public/laundry/events")
    fun laundryEvents(
        @RequestParam(required = false) since: String?,
        @RequestParam(defaultValue = "100") @Min(1) @Max(500) limit: Int,
    ) = latest(service.laundryEvents(since?.let(Instant::parse), limit))

    @GetMapping("/api/public/meals")
    fun meals() = latest(service.meals())

    @GetMapping("/api/public/meals/history")
    fun mealHistory(@RequestParam month: String) = latest(service.mealHistory(month))

    @GetMapping("/api/public/assets/{sha}.{extension}")
    fun asset(@PathVariable sha: String, @PathVariable extension: String): ResponseEntity<ByteArray> {
        require(sha.matches(Regex("^[a-f0-9]{64}$")))
        require(extension.matches(Regex("^[a-z0-9]{1,8}$")))
        val asset = service.asset(sha, extension)
        return ResponseEntity.ok()
            .header(HttpHeaders.CACHE_CONTROL, immutableCache)
            .header("X-Content-Type-Options", "nosniff")
            .header("Cross-Origin-Resource-Policy", "cross-origin")
            .contentType(MediaType.parseMediaType(asset.contentType))
            .contentLength(asset.bytes.size.toLong())
            .body(asset.bytes)
    }

    private fun <T : Any> latest(value: T): ResponseEntity<T> = ResponseEntity.ok()
        .header(HttpHeaders.CACHE_CONTROL, latestCache).body(value)

    private fun <T : Any> immutable(value: T): ResponseEntity<T> = ResponseEntity.ok()
        .header(HttpHeaders.CACHE_CONTROL, immutableCache).body(value)
}
