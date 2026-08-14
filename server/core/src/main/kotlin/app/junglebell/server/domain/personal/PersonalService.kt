package app.junglebell.server.domain.personal

import app.junglebell.server.common.error.ApiException
import app.junglebell.server.domain.security.TokenCodec
import org.springframework.http.HttpStatus
import org.springframework.stereotype.Service
import java.time.Clock
import java.util.UUID

@Service
class PersonalService(
    private val store: PersonalStore,
    private val tokens: TokenCodec,
    private val clock: Clock,
) {
    fun attendance(userId: UUID) = store.attendance(userId)

    fun updateAttendance(userId: UUID, value: AttendancePreferences): AttendancePreferences {
        value.validate()
        return store.saveAttendance(userId, value, clock.millis())
    }

    fun meal(userId: UUID) = store.meal(userId)

    fun updateMeal(userId: UUID, value: MealPreferencesInput): MealPreferences {
        return store.saveMeal(userId, value, clock.millis())
    }

    fun watches(userId: UUID) = LaundryWatchList(store.watches(userId))

    fun createWatch(userId: UUID, value: LaundryWatchInput): LaundryWatch {
        value.validate()
        val now = clock.millis()
        val watch = LaundryWatch(
            tokens.opaque("jbw_"),
            value.machineId,
            value.appliance,
            value.sessionId,
            value.notifyBeforeMinutes,
            value.notifyWhenAvailable,
            "active",
            now,
            now,
        )
        if (!store.createWatch(userId, watch)) {
            throw ApiException("LAUNDRY_WATCH_ALREADY_ACTIVE", HttpStatus.CONFLICT)
        }
        return watch
    }

    fun deleteWatch(userId: UUID, id: String) {
        if (!id.matches(Regex("^jbw_[a-f0-9]{64}$"))) throw ApiException("INVALID_REQUEST")
        if (!store.cancelWatch(userId, id, clock.millis())) {
            throw ApiException("LAUNDRY_WATCH_NOT_FOUND", HttpStatus.NOT_FOUND)
        }
    }
}
