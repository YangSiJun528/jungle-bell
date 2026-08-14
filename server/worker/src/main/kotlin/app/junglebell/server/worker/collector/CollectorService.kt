package app.junglebell.server.worker.collector

import app.junglebell.server.common.config.JungleBellProperties
import app.junglebell.server.domain.publicapi.MinuteObservation
import app.junglebell.server.domain.publicapi.PublicDataStore
import tools.jackson.databind.ObjectMapper
import org.slf4j.LoggerFactory
import org.springframework.stereotype.Service
import org.springframework.web.client.RestClient
import java.time.Clock
import java.time.Instant

@Service
class CollectorService(
    private val restClient: RestClient,
    private val objectMapper: ObjectMapper,
    private val store: PublicDataStore,
    private val laundryNormalizer: LaundryNormalizer,
    private val mealNormalizer: MealNormalizer,
    private val properties: JungleBellProperties,
    private val clock: Clock,
) {
    private val logger = LoggerFactory.getLogger(javaClass)

    fun collectLaundry() {
        val scheduledAt = floorMinute(clock.instant())
        val startedAt = clock.millis()
        var httpStatus: Int? = null
        try {
            val response = restClient.get().uri(properties.collectors.laundryUrl!!)
                .retrieve().toEntity(String::class.java)
            httpStatus = response.statusCode.value()
            val raw = response.body ?: error("Empty laundry response")
            val sha = sha256(raw)
            val previous = store.latestLaundryVersion()
            val version = laundryNormalizer.normalize(objectMapper.readTree(raw), sha, clock.instant(), previous)
            val state = store.sourceState("laundry")
            val changed = state?.lastResponseSha != sha
            val firstSeenAt = state?.takeIf { !changed }?.versionFirstSeenAt
                ?.let(Instant::parse) ?: clock.instant()
            store.recordLaundrySuccess(
                version,
                firstSeenAt,
                MinuteObservation(
                    "laundry", scheduledAt.epochSecond / 60, scheduledAt.toString(), clock.instant().toString(),
                    "SUCCESS", sha, firstSeenAt.toString(), changed, clock.millis() - startedAt,
                    httpStatus, null,
                ),
            )
        } catch (error: Exception) {
            val now = clock.instant()
            val message = error.message ?: error.javaClass.simpleName
            store.recordLaundryFailure(
                now,
                MinuteObservation(
                    "laundry", scheduledAt.epochSecond / 60, scheduledAt.toString(), now.toString(), "FAILED",
                    null, null, false, clock.millis() - startedAt, httpStatus, message,
                ),
                message,
            )
            throw error
        }
    }

    fun collectMeals() {
        val urls = listOf(
            "meals-include-pinned" to properties.collectors.mealsPinnedUrl,
            "meals-default" to properties.collectors.mealsDefaultUrl,
        )
        val failures = mutableListOf<Throwable>()
        urls.forEach { (source, url) ->
            if (url == null) return@forEach
            try {
                val observedAt = clock.instant()
                val raw = restClient.get().uri(url).retrieve().body(String::class.java)
                    ?: error("Empty meal response")
                val sha = sha256(raw)
                val posts = mealNormalizer.normalize(objectMapper.readTree(raw), observedAt)
                store.recordMealCollection(source, sha, observedAt, posts)
            } catch (error: Exception) {
                store.recordMealFailure(source, clock.instant(), error.message ?: error.javaClass.simpleName)
                logger.error("Meal collection failed for {}", source, error)
                failures += error
            }
        }
        if (failures.isNotEmpty()) {
            throw IllegalStateException("${failures.size} meal source collection(s) failed", failures.first())
        }
    }

    private fun floorMinute(value: Instant): Instant = Instant.ofEpochSecond(value.epochSecond / 60 * 60)
}
