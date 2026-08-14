package app.junglebell.server.domain.automation

import java.time.Instant
import java.util.UUID

interface AutomationStore {
    fun tryAcquireLease(name: String, now: Long, durationMs: Long, token: String): Boolean
    fun runHousekeepingIfDue(name: String, now: Long, durationMs: Long, token: String): Map<String, Int>?
    fun attendancePreferences(): List<AttendanceCandidate>
    fun desktopStates(userId: UUID): List<DesktopState>
    fun recentMealPublications(since: Instant): List<MealPublication>
    fun mealSubscriberUserIds(period: String): List<UUID>
    fun activeLaundryWatches(): List<ActiveLaundryWatch>
    fun completeLaundryWatch(id: String, now: Long): Boolean
    fun claimPushDeliveries(now: Long, leaseToken: String, limit: Int): List<PushDelivery>
    fun settlePush(
        delivery: PushDelivery,
        leaseToken: String,
        status: String,
        now: Long,
        nextAttemptAt: Long?,
        error: String?,
    ): Boolean
}

data class AttendanceCandidate(
    val userId: UUID,
    val morning: Boolean,
    val evening: Boolean,
    val morningStartHour: Int,
    val eveningEndHour: Int,
    val morningIntervalMinutes: Int,
    val eveningIntervalMinutes: Int,
    val skipSunday: Boolean,
    val skipAttendanceDate: String?,
    val attendanceDate: String?,
    val cohortStatus: String?,
    val morningChecked: Boolean?,
    val eveningChecked: Boolean?,
    val collectedAtEpochMs: Long?,
)

data class DesktopState(val lastSeenAtEpochMs: Long?, val lmsSessionState: String)

data class MealPublication(
    val id: String,
    val contentSha: String,
    val title: String?,
    val body: String,
    val publishedAt: Instant?,
    val updatedAt: Instant?,
    val firstSeenAt: Instant,
    val contentFirstSeenAt: Instant,
)

data class ActiveLaundryWatch(
    val id: String,
    val userId: UUID,
    val machineId: String,
    val appliance: String,
    val sessionId: String?,
    val notifyBeforeMinutes: Int,
    val notifyWhenAvailable: Boolean,
)

data class PushDelivery(
    val notificationId: UUID,
    val subscriptionId: String,
    val attempts: Int,
    val payloadJson: String,
    val expiresAtEpochMs: Long,
    val endpoint: String,
    val p256dh: String,
    val auth: String,
)
