package app.junglebell.server.domain.publicapi

import java.time.Instant

data class SourceState(
    val source: String,
    val lastAttemptAt: String,
    val lastSuccessAt: String?,
    val lastResponseSha: String?,
    val versionFirstSeenAt: String?,
    val consecutiveFailures: Int,
    val lastError: String?,
)

data class PublicStatus(val asOf: String, val sources: List<SourceState>)

data class PublicHealth(val status: String, val checkedAt: String, val sources: List<SourceState>)

data class NormalizedEnum(val code: String, val raw: String?, val known: Boolean)

data class LaundryProjection(
    val asOf: String,
    val remainingMinutes: Int?,
    val status: String,
    val estimated: Boolean,
)

data class LaundryAppliance(
    val machineId: String,
    val appliance: String,
    val observedAt: String,
    val state: NormalizedEnum,
    val operationalStatus: String,
    val remainingMinutes: Int,
    val totalMinutes: Int,
    val startedAt: String,
    val estimatedFinishAt: String?,
    val remoteControlEnabled: Boolean?,
    val cycleCount: Int?,
    val sessionId: String?,
    val errorCode: String?,
    val projection: LaundryProjection? = null,
    val attempts: Int = 0,
    val errors: Int = 0,
    val rate: Double = 0.0,
    val riskLevel: String = "safe",
)

data class LaundryMachine(val id: String, val washer: LaundryAppliance?, val dryer: LaundryAppliance?)

data class LaundryRiskKey(val machineId: String, val appliance: String)

data class LaundryRisk(
    val attempts: Int,
    val errors: Int,
    val rate: Double,
    val riskLevel: String,
) {
    companion object {
        fun calculate(attempts: Int, errors: Int): LaundryRisk {
            require(attempts >= 0 && errors in 0..attempts)
            val rate = if (attempts == 0) 0.0 else errors * 100.0 / attempts
            val riskLevel = when {
                rate > 40.0 -> "caution"
                rate > 10.0 -> "slight"
                else -> "safe"
            }
            return LaundryRisk(attempts, errors, rate, riskLevel)
        }
    }
}

data class UnknownEnumObservation(
    val machineId: String,
    val appliance: String,
    val fieldPath: String,
    val value: String,
)

data class LaundryEvent(
    val id: String,
    val machineId: String,
    val appliance: String,
    val sessionId: String?,
    val type: String,
    val previousObservedAt: String?,
    val observedAt: String,
    val etaDeltaMinutes: Double?,
    val previousState: String?,
    val currentState: String,
    val detail: Map<String, Any?>,
)

data class LaundryVersion(
    val schemaVersion: Int = 1,
    val sourceVersionSha: String,
    val observedAt: String,
    val machines: List<LaundryMachine>,
    val events: List<LaundryEvent>,
    val unknownEnums: List<UnknownEnumObservation>,
)

data class LaundryQuality(
    val collectorHealthy: Boolean,
    val collection: String,
    val sourceFreshness: String,
    val certainty: String,
    val basis: String = "HASH_CADENCE",
    val lastCheckedAt: String?,
    val expectedRefreshIntervalSeconds: Int = 300,
)

data class LaundryCapacityEstimate(
    val access: String,
    val washerAvailable: Int,
    val projectedDryerSupply: Int,
    val pendingDryerLoads: Int,
    val dryerHeadroom: Int,
    val startableLoads: Int?,
    val reliable: Boolean,
)

data class LaundryCapacity(
    val basis: String = "WASHER_AND_DRYER_HEADROOM_60_MIN",
    val men: LaundryCapacityEstimate,
    val women: LaundryCapacityEstimate,
)

data class PublicLaundrySnapshot(
    val schemaVersion: Int = 1,
    val sourceVersionSha: String,
    val asOf: String,
    val final: Boolean,
    val quality: LaundryQuality,
    val machines: List<LaundryMachine>,
    val events: List<LaundryEvent>,
    val unknownEnums: List<UnknownEnumObservation>,
    val capacity: LaundryCapacity,
)

data class MinuteObservation(
    val source: String,
    val minuteEpoch: Long,
    val scheduledAt: String,
    val collectedAt: String,
    val status: String,
    val versionSha: String?,
    val versionFirstSeenAt: String?,
    val changed: Boolean,
    val durationMs: Long,
    val httpStatus: Int?,
    val error: String?,
)

data class MinuteLaundryResponse(
    val minute: String,
    val observation: MinuteObservation,
    val data: PublicLaundrySnapshot?,
)

data class MealImage(
    val postId: String,
    val mediaId: String,
    val sourceUrl: String,
    val declaredContentType: String?,
    val filename: String?,
    val width: Int?,
    val height: Int?,
    val sha: String,
    val url: String,
    val contentType: String,
    val extension: String,
    val byteLength: Long,
)

data class MealPost(
    val id: String,
    val kind: String,
    val contentSha: String,
    val title: String?,
    val text: String,
    val pinned: Boolean,
    val publishedAt: String?,
    val updatedAt: String?,
    val permalink: String?,
    val status: String?,
    val images: List<MealImage>,
    val firstSeenAt: String? = null,
    val lastSeenAt: String? = null,
)

data class WeeklyMealMenu(val weekKey: String, val contentSha: String, val post: MealPost)

data class CurrentWeeklyMealMenu(
    val targetWeekKey: String,
    val status: String,
    val contentSha: String?,
    val post: MealPost?,
)

data class MealsData(
    val schemaVersion: Int = 2,
    val dailyMenus: List<MealPost>,
    val pinnedMenus: List<MealPost>,
    val recentMenus: List<MealPost>,
    val currentWeeklyMenu: CurrentWeeklyMealMenu,
    val weeklyMenus: List<WeeklyMealMenu>,
)

data class PublicMealsSnapshot(val asOf: String, val lastCheckedAt: String?, val data: MealsData)
data class MealHistoryResponse(val posts: List<MealPost>)
data class StoredAsset(val bytes: ByteArray, val contentType: String, val extension: String)

fun Instant.iso(): String = toString()
