package app.junglebell.server.domain.publicapi

import app.junglebell.server.common.error.ApiException
import app.junglebell.server.common.config.JungleBellProperties
import org.springframework.http.HttpStatus
import org.slf4j.LoggerFactory
import org.springframework.stereotype.Service
import java.time.Clock
import java.time.DayOfWeek
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.YearMonth
import java.time.ZoneId
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min

@Service
class PublicDataService(
    private val store: PublicDataStore,
    private val clock: Clock,
    private val properties: JungleBellProperties,
) {
    private val logger = LoggerFactory.getLogger(javaClass)
    private val kst = ZoneId.of("Asia/Seoul")

    fun health(): Pair<PublicHealth, HttpStatus> {
        logger.debug("Public health evaluation started.")
        val now = clock.instant()
        val states = store.sourceStates()
        val degraded = states.size < 3 || states.any {
            it.lastSuccessAt == null || it.consecutiveFailures > 0 ||
                Duration.between(Instant.parse(it.lastSuccessAt), now) > Duration.ofMinutes(15)
        }
        val status = if (degraded) HttpStatus.SERVICE_UNAVAILABLE else HttpStatus.OK
        val response = PublicHealth(if (degraded) "DEGRADED" else "OK", now.toString(), states) to status
        logger.debug("Public health evaluation completed. status={} sourceCount={}", status.value(), states.size)
        return response
    }

    fun status(): PublicStatus {
        logger.debug("Public status lookup started.")
        val response = PublicStatus(cacheSlice(clock.instant()).toString(), store.sourceStates())
        logger.debug("Public status lookup completed. sourceCount={}", response.sources.size)
        return response
    }

    fun laundryHead(): SourceState {
        logger.debug("Laundry head lookup started.")
        val response = store.sourceState("laundry")
        if (response == null) {
            logger.warn("Laundry head lookup rejected. reason=no_data")
            throw ApiException("NO_DATA", HttpStatus.SERVICE_UNAVAILABLE)
        }
        logger.debug("Laundry head lookup completed. result=available")
        return response
    }

    fun laundry(): PublicLaundrySnapshot {
        logger.debug("Laundry snapshot lookup started.")
        val version = store.latestLaundryVersion()
        if (version == null) {
            logger.warn("Laundry snapshot lookup rejected. reason=no_data")
            throw ApiException("NO_DATA", HttpStatus.SERVICE_UNAVAILABLE)
        }
        val asOf = cacheSlice(clock.instant())
        val response = project(
            version,
            store.sourceState("laundry"),
            asOf,
            false,
            store.laundryRisks(asOf.minus(Duration.ofDays(7)), asOf),
        )
        logger.debug("Laundry snapshot lookup completed. machineCount={}", response.machines.size)
        return response
    }

    fun laundryVersion(sha: String): LaundryVersion {
        logger.debug("Laundry version lookup started.")
        val response = store.laundryVersion(sha)
        if (response == null) {
            logger.warn("Laundry version lookup rejected. reason=version_not_found")
            throw ApiException("VERSION_NOT_FOUND", HttpStatus.NOT_FOUND)
        }
        logger.debug("Laundry version lookup completed. result=available")
        return response
    }

    fun laundryAt(minute: String): MinuteLaundryResponse {
        logger.debug("Historical laundry lookup started.")
        val instant = parseCompactMinute(minute)
        if (instant == null) {
            logger.warn("Historical laundry lookup rejected. reason=invalid_minute")
            throw ApiException("INVALID_MINUTE")
        }
        val observation = store.observation(instant.epochSecond / 60)
        if (observation == null) {
            logger.warn("Historical laundry lookup rejected. reason=observation_not_found")
            throw ApiException("OBSERVATION_NOT_FOUND", HttpStatus.NOT_FOUND)
        }
        val data = observation.versionSha?.let(store::laundryVersion)?.let {
            project(
                it,
                historicalState(observation),
                instant,
                true,
                store.laundryRisks(instant.minus(Duration.ofDays(7)), instant),
            )
        }
        val response = MinuteLaundryResponse(minute, observation, data)
        logger.debug("Historical laundry lookup completed. dataAvailable={}", data != null)
        return response
    }

    fun laundryEvents(since: Instant?, limit: Int): Map<String, List<LaundryEvent>> {
        logger.debug("Laundry event lookup started. limit={}", limit)
        val events = store.laundryEvents(since, limit)
        logger.debug("Laundry event lookup completed. eventCount={}", events.size)
        return mapOf("events" to events)
    }

    fun meals(): PublicMealsSnapshot {
        logger.debug("Meal snapshot lookup started.")
        val state = store.sourceState("meals-include-pinned")
        if (state == null) {
            logger.warn("Meal snapshot lookup rejected. reason=no_source_state")
            throw ApiException("NO_DATA", HttpStatus.SERVICE_UNAVAILABLE)
        }
        val posts = store.mealPosts(100).map {
            it.withPublicAssetUrls(properties.publicBaseUrl)
        }
        if (posts.isEmpty()) {
            logger.warn("Meal snapshot lookup rejected. reason=no_posts")
            throw ApiException("NO_DATA", HttpStatus.SERVICE_UNAVAILABLE)
        }
        val weekly = store.weeklyMenus(100).map {
            it.withPublicAssetUrls(properties.publicBaseUrl)
        }
        val target = targetWeek(clock.instant())
        val current = weekly.firstOrNull { it.weekKey == target }
        val response = PublicMealsSnapshot(
            cacheSlice(clock.instant()).toString(),
            state.lastSuccessAt,
            MealsData(
                dailyMenus = posts.filter { it.kind == "DAILY_MENU" },
                pinnedMenus = posts.filter { it.kind == "PINNED_MENU" },
                recentMenus = posts.filter { it.kind == "DAILY_MENU" }.take(40),
                currentWeeklyMenu = CurrentWeeklyMealMenu(
                    target,
                    if (current == null) "AWAITING_UPDATE" else "AVAILABLE",
                    current?.contentSha,
                    current?.post,
                ),
                weeklyMenus = weekly,
            ),
        )
        logger.debug("Meal snapshot lookup completed. postCount={} weeklyMenuCount={}", posts.size, weekly.size)
        return response
    }

    fun mealHistory(month: String): MealHistoryResponse {
        logger.debug("Meal history lookup started.")
        val yearMonth = try {
            YearMonth.parse(month)
        } catch (_: Exception) {
            logger.warn("Meal history lookup rejected. reason=invalid_month")
            throw ApiException("INVALID_REQUEST")
        }
        val from = yearMonth.atDay(1).atStartOfDay(kst).toInstant()
        val to = yearMonth.plusMonths(1).atDay(1).atStartOfDay(kst).toInstant()
        val response = MealHistoryResponse(
            store.mealPostsForMonth(from, to).map {
                it.withPublicAssetUrls(properties.publicBaseUrl)
            },
        )
        logger.debug("Meal history lookup completed. postCount={}", response.posts.size)
        return response
    }

    fun asset(sha: String, extension: String): StoredAsset {
        logger.debug("Meal asset lookup started.")
        val asset = store.asset(sha)
        if (asset == null || asset.extension != extension) {
            logger.warn("Meal asset lookup rejected. reason=asset_not_found")
            throw ApiException("ASSET_NOT_FOUND", HttpStatus.NOT_FOUND)
        }
        logger.debug("Meal asset lookup completed. contentLength={}", asset.bytes.size)
        return asset
    }

    fun compactMinute(instant: Instant): String = java.time.format.DateTimeFormatter.ofPattern("yyyyMMdd'T'HHmm'Z'")
        .withZone(java.time.ZoneOffset.UTC).format(instant)

    private fun project(
        version: LaundryVersion,
        state: SourceState?,
        asOf: Instant,
        final: Boolean,
        risks: Map<LaundryRiskKey, LaundryRisk>,
    ): PublicLaundrySnapshot {
        val versionAt = Instant.parse(version.observedAt)
        val ageSeconds = Duration.between(versionAt, asOf).seconds.coerceAtLeast(0)
        val anyActive = version.machines.any { machine ->
            listOfNotNull(machine.washer, machine.dryer).any { it.operationalStatus == "RUNNING" }
        }
        val collectionAge = state?.lastSuccessAt?.let { Duration.between(Instant.parse(it), asOf).seconds } ?: Long.MAX_VALUE
        val collectorHealthy = state != null &&
            state.consecutiveFailures == 0 &&
            state.lastError == null &&
            collectionAge <= 120
        val freshness = when {
            !collectorHealthy -> "COLLECTION_GAP"
            ageSeconds <= 60 -> "REFRESH_OBSERVED"
            anyActive && ageSeconds > 360 -> "REFRESH_OVERDUE"
            anyActive && ageSeconds <= 300 -> "WITHIN_REFRESH_WINDOW"
            else -> "UNVERIFIABLE_STABLE"
        }
        val machines = version.machines.map { machine ->
            LaundryMachine(
                machine.id,
                machine.washer?.let {
                    projectAppliance(it, asOf, risks[LaundryRiskKey(machine.id, "washer")])
                },
                machine.dryer?.let {
                    projectAppliance(it, asOf, risks[LaundryRiskKey(machine.id, "dryer")])
                },
            )
        }
        val quality = LaundryQuality(
            collectorHealthy = collectorHealthy,
            collection = if (freshness == "COLLECTION_GAP") "STALE" else "SUCCESS",
            sourceFreshness = freshness,
            certainty = when {
                freshness == "COLLECTION_GAP" -> "UNAVAILABLE"
                anyActive && freshness != "REFRESH_OBSERVED" -> "PROVISIONAL_DEVICE_STATE"
                else -> "OBSERVED_API_VALUE"
            },
            lastCheckedAt = state?.lastSuccessAt,
        )
        val provisional = PublicLaundrySnapshot(
            sourceVersionSha = version.sourceVersionSha,
            asOf = asOf.toString(),
            final = final,
            quality = quality,
            machines = machines,
            events = version.events,
            unknownEnums = version.unknownEnums,
            capacity = LaundryCapacity(
                men = capacity(machines, "men", quality),
                women = capacity(machines, "women", quality),
            ),
        )
        return provisional
    }

    private fun projectAppliance(
        value: LaundryAppliance,
        asOf: Instant,
        risk: LaundryRisk?,
    ): LaundryAppliance {
        var remaining: Int? = value.remainingMinutes
        var estimated = false
        val status = when (value.operationalStatus) {
            "RUNNING" -> {
                remaining = value.estimatedFinishAt?.let {
                    max(0, ceil(Duration.between(asOf, Instant.parse(it)).seconds / 60.0).toInt())
                } ?: value.remainingMinutes
                estimated = asOf.isAfter(Instant.parse(value.observedAt))
                if (remaining == 0) "AWAITING_COMPLETION_CONFIRMATION" else "ESTIMATED_RUNNING"
            }
            "COMPLETED" -> { remaining = 0; "CONFIRMED_COMPLETED" }
            "PAUSED" -> "PAUSED"
            "ERROR" -> "ERROR"
            "IDLE", "SCHEDULED" -> "IDLE"
            else -> { remaining = null; "UNKNOWN" }
        }
        val recentRisk = risk ?: LaundryRisk.calculate(0, 0)
        return value.copy(
            projection = LaundryProjection(asOf.toString(), remaining, status, estimated),
            attempts = recentRisk.attempts,
            errors = recentRisk.errors,
            rate = recentRisk.rate,
            riskLevel = recentRisk.riskLevel,
        )
    }

    private fun capacity(machines: List<LaundryMachine>, access: String, quality: LaundryQuality): LaundryCapacityEstimate {
        val accessible = machines.filter { zoneMatches(it.id, access) }
        val required = if (access == "men") (1..7).toList() else (6..9).toList()
        val complete = required.all { number ->
            machines.any { machineNumber(it.id) == number && it.washer != null && it.dryer != null }
        }
        val washerAvailable = accessible.count { available(it.washer) }
        val projectedDryerSupply = accessible.count { available(it.dryer) || dryerWithinHour(it.dryer) }
        val pendingDryerLoads = accessible.count { pendingDryer(it.washer) }
        val dryerHeadroom = max(0, projectedDryerSupply - pendingDryerLoads)
        val reliable = quality.collection == "SUCCESS" &&
            quality.sourceFreshness in setOf("REFRESH_OBSERVED", "WITHIN_REFRESH_WINDOW", "UNVERIFIABLE_STABLE") && complete
        return LaundryCapacityEstimate(
            access,
            washerAvailable,
            projectedDryerSupply,
            pendingDryerLoads,
            dryerHeadroom,
            if (reliable) min(washerAvailable, dryerHeadroom) else null,
            reliable,
        )
    }

    private fun available(appliance: LaundryAppliance?): Boolean =
        appliance?.operationalStatus == "IDLE" && appliance.projection?.status == "IDLE"

    private fun dryerWithinHour(appliance: LaundryAppliance?): Boolean {
        appliance ?: return false
        if (appliance.operationalStatus == "ERROR" || appliance.projection?.status in setOf("PAUSED", "AWAITING_COMPLETION_CONFIRMATION", "UNKNOWN")) return false
        val remaining = appliance.projection?.remainingMinutes ?: return false
        return remaining in 0..60 && (appliance.operationalStatus == "RUNNING" || appliance.projection.status in setOf("OBSERVED", "ESTIMATED_RUNNING"))
    }

    private fun pendingDryer(appliance: LaundryAppliance?): Boolean {
        appliance ?: return false
        if (available(appliance) || appliance.operationalStatus == "ERROR") return false
        val projection = appliance.projection ?: return false
        if (appliance.operationalStatus !in setOf("RUNNING", "COURSE_RUNNING", "PAUSED", "SCHEDULED") &&
            projection.status !in setOf("OBSERVED", "ESTIMATED_RUNNING", "AWAITING_COMPLETION_CONFIRMATION", "PAUSED")) return false
        if (appliance.operationalStatus in setOf("PAUSED", "SCHEDULED") || projection.status in setOf("PAUSED", "AWAITING_COMPLETION_CONFIRMATION")) return true
        return projection.remainingMinutes == null || projection.remainingMinutes <= 60
    }

    private fun zoneMatches(id: String, access: String): Boolean {
        val number = machineNumber(id) ?: return false
        return number in 6..7 || if (access == "men") number in 1..5 else number in 8..9
    }

    private fun machineNumber(id: String): Int? = Regex("(?:워시타워[_\\s-]*)?(\\d+)$")
        .find(id.trim())?.groupValues?.get(1)?.toIntOrNull()

    private fun targetWeek(reference: Instant): String {
        var date = reference.atZone(kst).toLocalDate()
        if (date.dayOfWeek == DayOfWeek.SUNDAY) date = date.plusDays(1)
        return date.minusDays((date.dayOfWeek.value - 1).toLong()).toString()
    }

    private fun cacheSlice(value: Instant): Instant = Instant.ofEpochMilli(value.toEpochMilli() / 30_000 * 30_000)

    private fun parseCompactMinute(value: String): Instant? = try {
        java.time.LocalDateTime.parse(
            value,
            java.time.format.DateTimeFormatter.ofPattern("yyyyMMdd'T'HHmm'Z'"),
        ).toInstant(java.time.ZoneOffset.UTC)
    } catch (_: Exception) {
        null
    }

    private fun historicalState(observation: MinuteObservation) = SourceState(
        "laundry",
        observation.collectedAt,
        observation.collectedAt.takeIf { observation.status == "SUCCESS" },
        observation.versionSha,
        observation.versionFirstSeenAt,
        if (observation.status == "SUCCESS") 0 else 1,
        observation.error,
    )
}
