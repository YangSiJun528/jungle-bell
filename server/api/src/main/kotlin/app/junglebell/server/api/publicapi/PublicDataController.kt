package app.junglebell.server.api.publicapi

import app.junglebell.server.domain.publicapi.*
import jakarta.validation.constraints.Max
import jakarta.validation.constraints.Min
import org.springframework.http.CacheControl
import org.springframework.http.HttpHeaders
import org.springframework.http.HttpStatus
import org.springframework.http.MediaType
import org.springframework.http.ResponseEntity
import org.slf4j.LoggerFactory
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
    private val logger = LoggerFactory.getLogger(javaClass)
    private val latestCache = "public, max-age=15, s-maxage=30, stale-while-revalidate=120"
    private val immutableCache = "public, max-age=31536000, immutable"

    @GetMapping("/api/health")
    fun health(): ResponseEntity<PublicHealth> {
        logger.debug("Public health request received.")
        val (body, status) = service.health()
        logger.debug("Public health request completed. status={}", status.value())
        return ResponseEntity.status(status).body(body)
    }

    @GetMapping("/api/public/status")
    fun status(): ResponseEntity<PublicStatus> {
        logger.debug("Public status request received.")
        val response = latest(service.status())
        logger.debug("Public status request completed. status=200")
        return response
    }

    @GetMapping("/api/public/laundry/head")
    fun laundryHead(): ResponseEntity<SourceState> {
        logger.debug("Laundry head request received.")
        val response = latest(service.laundryHead())
        logger.debug("Laundry head request completed. status=200")
        return response
    }

    @GetMapping("/api/public/laundry")
    fun laundry(): ResponseEntity<PublicLaundrySnapshot> {
        logger.debug("Laundry snapshot request received.")
        val response = latest(service.laundry())
        logger.debug("Laundry snapshot request completed. status=200")
        return response
    }

    @GetMapping("/api/public/laundry/at")
    fun laundryAt(@RequestParam time: String): ResponseEntity<Void> {
        logger.debug("Laundry time redirect request received.")
        val instant = Instant.parse(time)
        val response = ResponseEntity.status(308)
            .location(URI.create("/api/public/laundry/minutes/${service.compactMinute(instant)}"))
            .header(HttpHeaders.CACHE_CONTROL, immutableCache)
            .build<Void>()
        logger.debug("Laundry time redirect request completed. status=308")
        return response
    }

    @GetMapping("/api/public/laundry/minutes/{minute}")
    fun laundryMinute(@PathVariable minute: String): ResponseEntity<MinuteLaundryResponse> {
        logger.debug("Historical laundry request received.")
        val response = immutable(service.laundryAt(minute))
        logger.debug("Historical laundry request completed. status=200")
        return response
    }

    @GetMapping("/api/public/laundry/versions/{sha}")
    fun laundryVersion(@PathVariable sha: String): ResponseEntity<LaundryVersion> {
        logger.debug("Laundry version request received.")
        require(sha.matches(Regex("^[a-f0-9]{64}$")))
        val response = immutable(service.laundryVersion(sha))
        logger.debug("Laundry version request completed. status=200")
        return response
    }

    @GetMapping("/api/public/laundry/events")
    fun laundryEvents(
        @RequestParam(required = false) since: String?,
        @RequestParam(defaultValue = "100") @Min(1) @Max(500) limit: Int,
    ): ResponseEntity<Map<String, List<LaundryEvent>>> {
        logger.debug("Laundry event request received. limit={}", limit)
        val response = latest(service.laundryEvents(since?.let(Instant::parse), limit))
        logger.debug("Laundry event request completed. status=200")
        return response
    }

    @GetMapping("/api/public/meals")
    fun meals(): ResponseEntity<PublicMealsSnapshot> {
        logger.debug("Meal snapshot request received.")
        val response = latest(service.meals())
        logger.debug("Meal snapshot request completed. status=200")
        return response
    }

    @GetMapping("/api/public/meals/history")
    fun mealHistory(@RequestParam month: String): ResponseEntity<MealHistoryResponse> {
        logger.debug("Meal history request received.")
        val response = latest(service.mealHistory(month))
        logger.debug("Meal history request completed. status=200")
        return response
    }

    @GetMapping("/api/public/assets/{sha}.{extension}")
    fun asset(@PathVariable sha: String, @PathVariable extension: String): ResponseEntity<ByteArray> {
        logger.debug("Meal asset request received.")
        require(sha.matches(Regex("^[a-f0-9]{64}$")))
        require(extension.matches(Regex("^[a-z0-9]{1,8}$")))
        val asset = service.asset(sha, extension)
        val response = ResponseEntity.ok()
            .header(HttpHeaders.CACHE_CONTROL, immutableCache)
            .header("X-Content-Type-Options", "nosniff")
            .header("Cross-Origin-Resource-Policy", "cross-origin")
            .contentType(MediaType.parseMediaType(asset.contentType))
            .contentLength(asset.bytes.size.toLong())
            .body(asset.bytes)
        logger.debug("Meal asset request completed. status=200 contentLength={}", asset.bytes.size)
        return response
    }

    private fun <T : Any> latest(value: T): ResponseEntity<T> = ResponseEntity.ok()
        .header(HttpHeaders.CACHE_CONTROL, latestCache).body(value)

    private fun <T : Any> immutable(value: T): ResponseEntity<T> = ResponseEntity.ok()
        .header(HttpHeaders.CACHE_CONTROL, immutableCache).body(value)
}
