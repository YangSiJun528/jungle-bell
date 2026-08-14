package app.junglebell.server.domain.publicapi

import app.junglebell.server.common.error.ApiException
import app.junglebell.server.common.config.JungleBellProperties
import org.springframework.http.HttpStatus
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
    private val kst = ZoneId.of("Asia/Seoul")

    fun health(): Pair<PublicHealth, HttpStatus> {
        val now = clock.instant()
        val states = store.sourceStates()
        val degraded = states.size < 3 || states.any {
            it.lastSuccessAt == null || it.consecutiveFailures > 0 ||
                Duration.between(Instant.parse(it.lastSuccessAt), now) > Duration.ofMinutes(15)
        }
        return PublicHealth(if (degraded) "DEGRADED" else "OK", now.toString(), states) to
            if (degraded) HttpStatus.SERVICE_UNAVAILABLE else HttpStatus.OK
    }

    fun status(): PublicStatus = PublicStatus(cacheSlice(clock.instant()).toString(), store.sourceStates())

    fun laundryHead(): SourceState = store.sourceState("laundry")
        ?: throw ApiException("NO_DATA", HttpStatus.SERVICE_UNAVAILABLE)

    fun laundry(): PublicLaundrySnapshot {
        val version = store.latestLaundryVersion()
            ?: throw ApiException("NO_DATA", HttpStatus.SERVICE_UNAVAILABLE)
        return project(version, store.sourceState("laundry"), cacheSlice(clock.instant()), false)
    }

    fun laundryVersion(sha: String): LaundryVersion = store.laundryVersion(sha)
        ?: throw ApiException("VERSION_NOT_FOUND", HttpStatus.NOT_FOUND)

    fun laundryAt(minute: String): MinuteLaundryResponse {
        val instant = parseCompactMinute(minute) ?: throw ApiException("INVALID_MINUTE")
        val observation = store.observation(instant.epochSecond / 60)
            ?: throw ApiException("OBSERVATION_NOT_FOUND", HttpStatus.NOT_FOUND)
        val data = observation.versionSha?.let(store::laundryVersion)?.let {
            project(it, historicalState(observation), instant, true)
        }
        return MinuteLaundryResponse(minute, observation, data)
    }

    fun laundryEvents(since: Instant?, limit: Int) = mapOf("events" to store.laundryEvents(since, limit))

    fun meals(): PublicMealsSnapshot {
        val state = store.sourceState("meals-include-pinned")
            ?: throw ApiException("NO_DATA", HttpStatus.SERVICE_UNAVAILABLE)
        val posts = store.mealPosts(100).map {
            it.withPublicAssetUrls(properties.publicBaseUrl)
        }
        if (posts.isEmpty()) throw ApiException("NO_DATA", HttpStatus.SERVICE_UNAVAILABLE)
        val weekly = store.weeklyMenus(100).map {
            it.withPublicAssetUrls(properties.publicBaseUrl)
        }
        val target = targetWeek(clock.instant())
        val current = weekly.firstOrNull { it.weekKey == target }
        return PublicMealsSnapshot(
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
    }

    fun mealHistory(month: String): MealHistoryResponse {
        val yearMonth = try {
            YearMonth.parse(month)
        } catch (_: Exception) {
            throw ApiException("INVALID_REQUEST")
        }
        val from = yearMonth.atDay(1).atStartOfDay(kst).toInstant()
        val to = yearMonth.plusMonths(1).atDay(1).atStartOfDay(kst).toInstant()
        return MealHistoryResponse(
            store.mealPostsForMonth(from, to).map {
                it.withPublicAssetUrls(properties.publicBaseUrl)
            },
        )
    }

    fun asset(sha: String, extension: String): StoredAsset {
        val asset = store.asset(sha) ?: throw ApiException("ASSET_NOT_FOUND", HttpStatus.NOT_FOUND)
        if (asset.extension != extension) throw ApiException("ASSET_NOT_FOUND", HttpStatus.NOT_FOUND)
        return asset
    }

    fun compactMinute(instant: Instant): String = java.time.format.DateTimeFormatter.ofPattern("yyyyMMdd'T'HHmm'Z'")
        .withZone(java.time.ZoneOffset.UTC).format(instant)

    private fun project(
        version: LaundryVersion,
        state: SourceState?,
        asOf: Instant,
        final: Boolean,
    ): PublicLaundrySnapshot {
        val versionAt = Instant.parse(version.observedAt)
        val ageSeconds = Duration.between(versionAt, asOf).seconds.coerceAtLeast(0)
        val anyActive = version.machines.any { machine ->
            listOfNotNull(machine.washer, machine.dryer).any { it.operationalStatus == "RUNNING" }
        }
        val collectionAge = state?.lastSuccessAt?.let { Duration.between(Instant.parse(it), asOf).seconds } ?: Long.MAX_VALUE
        val freshness = when {
            state?.lastError != null || collectionAge > 120 -> "COLLECTION_GAP"
            ageSeconds <= 60 -> "REFRESH_OBSERVED"
            anyActive && ageSeconds > 360 -> "REFRESH_OVERDUE"
            anyActive && ageSeconds <= 300 -> "WITHIN_REFRESH_WINDOW"
            else -> "UNVERIFIABLE_STABLE"
        }
        val machines = version.machines.map { machine ->
            LaundryMachine(
                machine.id,
                machine.washer?.let { projectAppliance(it, asOf) },
                machine.dryer?.let { projectAppliance(it, asOf) },
            )
        }
        val quality = LaundryQuality(
            if (freshness == "COLLECTION_GAP") "STALE" else "SUCCESS",
            freshness,
            when {
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

    private fun projectAppliance(value: LaundryAppliance, asOf: Instant): LaundryAppliance {
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
        return value.copy(projection = LaundryProjection(asOf.toString(), remaining, status, estimated))
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
