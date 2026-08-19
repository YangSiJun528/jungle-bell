package app.junglebell.server.domain.personal

import jakarta.validation.constraints.Max
import jakarta.validation.constraints.Min
import jakarta.validation.constraints.Pattern
import jakarta.validation.constraints.Size

data class AttendancePreferences(
    val enabled: Boolean,
    val morning: Boolean,
    val evening: Boolean,
    @field:Min(4) @field:Max(9) val morningStartHour: Int,
    @field:Min(0) @field:Max(4) val eveningEndHour: Int,
    val morningIntervalMinutes: Int,
    val eveningIntervalMinutes: Int,
    val skipSunday: Boolean,
    @field:Pattern(regexp = "^\\d{4}-\\d{2}-\\d{2}$") val skipAttendanceDate: String?,
) {
    fun validate() {
        require(morningIntervalMinutes in ALLOWED_INTERVALS)
        require(eveningIntervalMinutes in ALLOWED_INTERVALS)
        skipAttendanceDate?.let(java.time.LocalDate::parse)
    }

    companion object {
        private val ALLOWED_INTERVALS = setOf(1, 3, 5, 10, 15, 30)
    }
}

data class MealPreferencesInput(
    val enabled: Boolean,
    val lunch: Boolean,
    val dinner: Boolean,
)

data class MealPreferences(
    val enabled: Boolean,
    val lunch: Boolean,
    val dinner: Boolean,
    val updatedAtEpochMs: Long,
)

data class LaundryWatchInput(
    @field:Size(min = 1, max = 128) val machineId: String,
    @field:Pattern(regexp = "^(washer|dryer)$") val appliance: String,
    @field:Size(min = 1, max = 256) val sessionId: String,
    @field:Pattern(regexp = "^(before-completion|estimated-completion|confirmed-completion)$")
    val notificationMode: String,
    @field:Min(0) @field:Max(180) val notifyBeforeMinutes: Int,
) {
    fun validate() {
        require(machineId.trim() == machineId)
        require(sessionId.trim() == sessionId)
        require(notificationMode in NOTIFICATION_MODES)
        require(
            if (notificationMode == "before-completion") notifyBeforeMinutes in 1..180
            else notifyBeforeMinutes == 0,
        )
    }

    private companion object {
        val NOTIFICATION_MODES = setOf(
            "before-completion",
            "estimated-completion",
            "confirmed-completion",
        )
    }
}

data class LaundryWatch(
    val id: String,
    val machineId: String,
    val appliance: String,
    val sessionId: String?,
    val notificationMode: String,
    val notifyBeforeMinutes: Int,
    val status: String,
    val createdAtEpochMs: Long,
    val updatedAtEpochMs: Long,
)

data class LaundryWatchList(val watches: List<LaundryWatch>)
