package app.junglebell.server.domain.personal

import app.junglebell.server.common.error.ApiException
import app.junglebell.server.domain.security.TokenCodec
import org.springframework.http.HttpStatus
import org.slf4j.LoggerFactory
import org.springframework.stereotype.Service
import java.time.Clock
import java.util.UUID

@Service
class PersonalService(
    private val store: PersonalStore,
    private val tokens: TokenCodec,
    private val clock: Clock,
) {
    private val logger = LoggerFactory.getLogger(javaClass)

    fun attendance(userId: UUID): AttendancePreferences {
        logger.debug("Attendance preference lookup started.")
        val response = store.attendance(userId)
        logger.debug("Attendance preference lookup completed.")
        return response
    }

    fun updateAttendance(userId: UUID, value: AttendancePreferences): AttendancePreferences {
        logger.info("Attendance preference update started.")
        value.validate()
        val response = store.saveAttendance(userId, value, clock.millis())
        logger.info("Attendance preference update completed. result=updated")
        return response
    }

    fun meal(userId: UUID): MealPreferences {
        logger.debug("Meal preference lookup started.")
        val response = store.meal(userId)
        logger.debug("Meal preference lookup completed.")
        return response
    }

    fun updateMeal(userId: UUID, value: MealPreferencesInput): MealPreferences {
        logger.info("Meal preference update started.")
        val response = store.saveMeal(userId, value, clock.millis())
        logger.info("Meal preference update completed. result=updated")
        return response
    }

    fun watches(userId: UUID): LaundryWatchList {
        logger.debug("Laundry watch lookup started.")
        val response = LaundryWatchList(store.watches(userId))
        logger.debug("Laundry watch lookup completed. watchCount={}", response.watches.size)
        return response
    }

    fun createWatch(userId: UUID, value: LaundryWatchInput): LaundryWatch {
        logger.info("Laundry watch creation started.")
        value.validate()
        val now = clock.millis()
        val watch = LaundryWatch(
            tokens.opaque("jbw_"),
            value.machineId,
            value.appliance,
            value.sessionId,
            value.notificationMode,
            value.notifyBeforeMinutes,
            "active",
            now,
            now,
        )
        if (!store.createWatch(userId, watch)) {
            logger.warn("Laundry watch creation rejected. reason=watch_already_active")
            throw ApiException("LAUNDRY_WATCH_ALREADY_ACTIVE", HttpStatus.CONFLICT)
        }
        logger.info("Laundry watch creation completed. watchId={}", watch.id)
        return watch
    }

    fun deleteWatch(userId: UUID, id: String) {
        logger.info("Laundry watch deletion started.")
        if (!id.matches(Regex("^jbw_[a-f0-9]{64}$"))) {
            logger.warn("Laundry watch deletion rejected. reason=invalid_watch_id")
            throw ApiException("INVALID_REQUEST")
        }
        if (!store.cancelWatch(userId, id, clock.millis())) {
            logger.warn("Laundry watch deletion rejected. reason=watch_not_found")
            throw ApiException("LAUNDRY_WATCH_NOT_FOUND", HttpStatus.NOT_FOUND)
        }
        logger.info("Laundry watch deletion completed. watchId={}", id)
    }
}
