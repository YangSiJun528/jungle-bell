package app.junglebell.server.personal

import app.junglebell.server.common.ApiException
import app.junglebell.server.security.TokenCodec
import org.springframework.dao.DataIntegrityViolationException
import org.springframework.http.HttpStatus
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import java.time.Clock
import java.util.UUID

@Service
class PersonalService(
    private val repository: PersonalRepository,
    private val tokens: TokenCodec,
    private val clock: Clock,
) {
    @Transactional(readOnly = true)
    fun attendance(userId: UUID) = repository.attendance(userId)

    @Transactional
    fun updateAttendance(userId: UUID, value: AttendancePreferences): AttendancePreferences {
        value.validate()
        repository.updateAttendance(userId, value, clock.millis())
        return repository.attendance(userId)
    }

    @Transactional(readOnly = true)
    fun meal(userId: UUID) = repository.meal(userId)

    @Transactional
    fun updateMeal(userId: UUID, value: MealPreferencesInput): MealPreferences {
        repository.updateMeal(userId, value, clock.millis())
        return repository.meal(userId)
    }

    @Transactional(readOnly = true)
    fun watches(userId: UUID) = LaundryWatchList(repository.watches(userId))

    @Transactional
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
        try {
            repository.insertWatch(userId, watch)
        } catch (_: DataIntegrityViolationException) {
            throw ApiException("LAUNDRY_WATCH_ALREADY_ACTIVE", HttpStatus.CONFLICT)
        }
        return watch
    }

    @Transactional
    fun deleteWatch(userId: UUID, id: String) {
        if (!id.matches(Regex("^jbw_[a-f0-9]{64}$"))) throw ApiException("INVALID_REQUEST")
        if (!repository.cancelWatch(userId, id, clock.millis())) {
            throw ApiException("LAUNDRY_WATCH_NOT_FOUND", HttpStatus.NOT_FOUND)
        }
    }
}
