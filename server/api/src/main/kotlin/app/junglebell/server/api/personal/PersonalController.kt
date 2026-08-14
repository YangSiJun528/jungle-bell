package app.junglebell.server.api.personal

import app.junglebell.server.domain.personal.*
import app.junglebell.server.api.security.CurrentSession
import app.junglebell.server.domain.security.SessionPrincipal
import jakarta.validation.Valid
import org.springframework.http.HttpStatus
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
    @GetMapping("/api/me/attendance/preferences")
    fun attendance(@CurrentSession principal: SessionPrincipal) = service.attendance(principal.userId)

    @PutMapping("/api/me/attendance/preferences")
    fun updateAttendance(
        @CurrentSession principal: SessionPrincipal,
        @Valid @RequestBody value: AttendancePreferences,
    ) = service.updateAttendance(principal.userId, value)

    @GetMapping("/api/me/meal-preferences")
    fun meal(@CurrentSession principal: SessionPrincipal) = service.meal(principal.userId)

    @PutMapping("/api/me/meal-preferences")
    fun updateMeal(
        @CurrentSession principal: SessionPrincipal,
        @Valid @RequestBody value: MealPreferencesInput,
    ) = service.updateMeal(principal.userId, value)

    @GetMapping("/api/me/laundry-watches")
    fun watches(@CurrentSession principal: SessionPrincipal) = service.watches(principal.userId)

    @PostMapping("/api/me/laundry-watches")
    @ResponseStatus(HttpStatus.CREATED)
    fun createWatch(
        @CurrentSession principal: SessionPrincipal,
        @Valid @RequestBody value: LaundryWatchInput,
    ) = service.createWatch(principal.userId, value)

    @DeleteMapping("/api/me/laundry-watches/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun deleteWatch(
        @CurrentSession principal: SessionPrincipal,
        @PathVariable id: String,
    ) = service.deleteWatch(principal.userId, id)
}
