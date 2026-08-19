package app.junglebell.server.api.personal

import app.junglebell.server.domain.personal.*
import app.junglebell.server.api.security.CurrentSession
import app.junglebell.server.domain.security.SessionPrincipal
import jakarta.validation.Valid
import org.springframework.http.HttpStatus
import org.slf4j.LoggerFactory
import org.springframework.web.bind.annotation.DeleteMapping
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.PutMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.ResponseStatus
import org.springframework.web.bind.annotation.RestController

@RestController
class PersonalController(private val service: PersonalService) {
    private val logger = LoggerFactory.getLogger(javaClass)

    @GetMapping("/api/me/attendance/preferences")
    fun attendance(@CurrentSession principal: SessionPrincipal): AttendancePreferences {
        logger.debug("Attendance preference request received.")
        val response = service.attendance(principal.userId)
        logger.debug("Attendance preference request completed. status=200")
        return response
    }

    @PutMapping("/api/me/attendance/preferences")
    fun updateAttendance(
        @CurrentSession principal: SessionPrincipal,
        @Valid @RequestBody value: AttendancePreferences,
    ): AttendancePreferences {
        logger.info("Attendance preference update request received.")
        val response = service.updateAttendance(principal.userId, value)
        logger.info("Attendance preference update request completed. status=200")
        return response
    }

    @GetMapping("/api/me/meal-preferences")
    fun meal(@CurrentSession principal: SessionPrincipal): MealPreferences {
        logger.debug("Meal preference request received.")
        val response = service.meal(principal.userId)
        logger.debug("Meal preference request completed. status=200")
        return response
    }

    @PutMapping("/api/me/meal-preferences")
    fun updateMeal(
        @CurrentSession principal: SessionPrincipal,
        @Valid @RequestBody value: MealPreferencesInput,
    ): MealPreferences {
        logger.info("Meal preference update request received.")
        val response = service.updateMeal(principal.userId, value)
        logger.info("Meal preference update request completed. status=200")
        return response
    }

    @GetMapping("/api/me/laundry-watches")
    fun watches(@CurrentSession principal: SessionPrincipal): LaundryWatchList {
        logger.debug("Laundry watch request received.")
        val response = service.watches(principal.userId)
        logger.debug("Laundry watch request completed. status=200")
        return response
    }

    @PostMapping("/api/me/laundry-watches")
    @ResponseStatus(HttpStatus.CREATED)
    fun createWatch(
        @CurrentSession principal: SessionPrincipal,
        @Valid @RequestBody value: LaundryWatchInput,
    ): LaundryWatch {
        logger.info("Laundry watch creation request received.")
        val response = service.createWatch(principal.userId, value)
        logger.info("Laundry watch creation request completed. watchId={} status=201", response.id)
        return response
    }

    @DeleteMapping("/api/me/laundry-watches/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun deleteWatch(
        @CurrentSession principal: SessionPrincipal,
        @PathVariable id: String,
    ) {
        logger.info("Laundry watch deletion request received.")
        service.deleteWatch(principal.userId, id)
        logger.info("Laundry watch deletion request completed. status=204")
    }
}
