package app.junglebell.server.account

import jakarta.validation.constraints.NotBlank
import jakarta.validation.constraints.Pattern
import jakarta.validation.constraints.Size
import java.time.Instant
import java.time.LocalDate

data class DesktopInstallationRequest(
    @field:Size(min = 8, max = 128)
    @field:Pattern(regexp = "^[A-Za-z0-9][A-Za-z0-9._:-]+$")
    val installationId: String,
)

data class AccessTokenResponse(val accessToken: String, val expiresAt: String)

data class DesktopUiSessionRequest(
    @field:NotBlank val origin: String,
)

data class DesktopHeartbeatRequest(
    @field:Pattern(regexp = "^(connected|login-required|unknown)$")
    val lmsSessionState: String,
    @field:Size(min = 1, max = 64) val appVersion: String?,
)

data class HeartbeatResponse(val receivedAt: String)

data class AttendanceSnapshotRequest(
    @field:Pattern(regexp = "^\\d{4}-\\d{2}-\\d{2}$") val attendanceDate: String,
    @field:Size(min = 1, max = 128) val cohortId: String?,
    @field:Pattern(regexp = "^(active|upcoming|ended|none|unknown)$") val cohortStatus: String,
    @field:Pattern(regexp = "^\\d{4}-\\d{2}-\\d{2}$") val cohortStartDate: String?,
    @field:Pattern(regexp = "^\\d{4}-\\d{2}-\\d{2}$") val cohortEndDate: String?,
    val morningChecked: Boolean,
    val eveningChecked: Boolean,
    val collectedAt: String,
) {
    fun validate() {
        LocalDate.parse(attendanceDate)
        cohortStartDate?.let(LocalDate::parse)
        cohortEndDate?.let(LocalDate::parse)
        Instant.parse(collectedAt)
        require(cohortStartDate == null || cohortEndDate == null || cohortStartDate <= cohortEndDate)
        when (cohortStatus) {
            "active" -> require(cohortId != null)
            "upcoming", "ended" -> require(cohortId == null && !morningChecked && !eveningChecked)
            "none" -> require(
                cohortId == null && cohortStartDate == null && cohortEndDate == null &&
                    !morningChecked && !eveningChecked,
            )
            "unknown" -> require(cohortId == null)
        }
    }
}

data class AttendanceSnapshotResponse(
    val attendanceDate: String,
    val cohortId: String?,
    val cohortStatus: String,
    val cohortStartDate: String?,
    val cohortEndDate: String?,
    val morningChecked: Boolean,
    val eveningChecked: Boolean,
    val collectedAt: String,
)

data class AttendanceEnvelope(
    val attendance: AttendanceSnapshotResponse?,
    val freshness: String,
)

data class DesktopDeviceResponse(
    val id: String,
    val deviceLabel: String?,
    val lastSeenAt: String?,
    val lmsSessionState: String,
    val health: String,
    val appVersion: String?,
)

data class MobileAttendanceEnvelope(
    val attendance: AttendanceSnapshotResponse?,
    val freshness: String,
    val devices: List<DesktopDeviceResponse>,
)

data class MobileSessionResponse(
    val deviceId: String,
    val deviceLabel: String,
    val installationId: String,
    val createdAt: String,
    val expiresAt: String,
    val lastSeenAt: String,
    val pushEnabled: Boolean,
    val status: String,
)

data class MobileSessionsEnvelope(val devices: List<MobileSessionResponse>)
