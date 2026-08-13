package app.junglebell.server.collector

import app.junglebell.server.config.JungleBellProperties
import app.junglebell.server.publicapi.MinuteObservation
import app.junglebell.server.publicapi.PublicDataRepository
import tools.jackson.databind.ObjectMapper
import org.slf4j.LoggerFactory
import org.springframework.scheduling.annotation.Scheduled
import org.springframework.stereotype.Service
import org.springframework.transaction.support.TransactionTemplate
import org.springframework.web.client.RestClient
import java.time.Clock
import java.time.Instant
import kotlin.system.measureTimeMillis

@Service
class CollectorService(
    private val restClient: RestClient,
    private val objectMapper: ObjectMapper,
    private val repository: PublicDataRepository,
    private val laundryNormalizer: LaundryNormalizer,
    private val mealNormalizer: MealNormalizer,
    private val properties: JungleBellProperties,
    private val clock: Clock,
    private val transactions: TransactionTemplate,
) {
    private val logger = LoggerFactory.getLogger(javaClass)

    @Scheduled(initialDelay = 5_000, fixedDelay = 60_000)
    fun collectLaundryScheduled() {
        if (!properties.collectors.enabled || properties.collectors.laundryUrl == null) return
        runCatching(::collectLaundry).onFailure { logger.error("Laundry collection failed", it) }
    }

    @Scheduled(initialDelay = 10_000, fixedDelay = 300_000)
    fun collectMealsScheduled() {
        if (!properties.collectors.enabled) return
        runCatching(::collectMeals).onFailure { logger.error("Meal collection failed", it) }
    }

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
            val previous = repository.latestLaundryVersion()
            val version = laundryNormalizer.normalize(objectMapper.readTree(raw), sha, clock.instant(), previous)
            val state = repository.sourceState("laundry")
            val changed = state?.lastResponseSha != sha
            val firstSeenAt = state?.takeIf { !changed }?.versionFirstSeenAt
                ?.let(Instant::parse) ?: clock.instant()
            transactions.executeWithoutResult {
                repository.saveLaundryVersion(version, firstSeenAt)
                repository.saveLaundryEvents(version.events)
                repository.saveObservation(
                    MinuteObservation(
                        "laundry", scheduledAt.epochSecond / 60, scheduledAt.toString(), clock.instant().toString(),
                        "SUCCESS", sha, firstSeenAt.toString(), changed, clock.millis() - startedAt,
                        httpStatus, null,
                    ),
                )
                repository.recordSourceSuccess(
                    "laundry",
                    version.sourceVersionSha,
                    Instant.parse(version.observedAt),
                    changed,
                )
            }
        } catch (error: Exception) {
            val now = clock.instant()
            transactions.executeWithoutResult {
                repository.recordSourceFailure("laundry", now, error.message ?: error.javaClass.simpleName)
                repository.saveObservation(
                    MinuteObservation(
                        "laundry", scheduledAt.epochSecond / 60, scheduledAt.toString(), now.toString(), "FAILED",
                        null, null, false, clock.millis() - startedAt, httpStatus,
                        error.message ?: error.javaClass.simpleName,
                    ),
                )
            }
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
                transactions.executeWithoutResult {
                    posts.forEach { normalized ->
                        repository.upsertMealPost(normalized.post, observedAt)
                        repository.replaceMealImages(normalized.post.id, normalized.images)
                        normalized.weekKey?.let { weekKey ->
                            repository.upsertWeeklyMenu(
                                weekKey,
                                normalized.post.contentSha,
                                normalized.post.id,
                                normalized.post.updatedAt?.let(Instant::parse),
                                observedAt,
                            )
                        }
                    }
                    repository.recordSourceSuccess(
                        source,
                        sha,
                        observedAt,
                        repository.sourceState(source)?.lastResponseSha != sha,
                    )
                }
            } catch (error: Exception) {
                transactions.executeWithoutResult {
                    repository.recordSourceFailure(source, clock.instant(), error.message ?: error.javaClass.simpleName)
                }
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
