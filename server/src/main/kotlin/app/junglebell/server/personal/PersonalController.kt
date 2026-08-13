package app.junglebell.server.personal

import app.junglebell.server.security.SessionPrincipal
import jakarta.validation.Valid
import org.springframework.http.HttpStatus
import org.springframework.security.core.annotation.AuthenticationPrincipal
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
    fun attendance(@AuthenticationPrincipal principal: SessionPrincipal) = service.attendance(principal.userId)

    @PutMapping("/api/me/attendance/preferences")
    fun updateAttendance(
        @AuthenticationPrincipal principal: SessionPrincipal,
        @Valid @RequestBody value: AttendancePreferences,
    ) = service.updateAttendance(principal.userId, value)

    @GetMapping("/api/me/meal-preferences")
    fun meal(@AuthenticationPrincipal principal: SessionPrincipal) = service.meal(principal.userId)

    @PutMapping("/api/me/meal-preferences")
    fun updateMeal(
        @AuthenticationPrincipal principal: SessionPrincipal,
        @Valid @RequestBody value: MealPreferencesInput,
    ) = service.updateMeal(principal.userId, value)

    @GetMapping("/api/me/laundry-watches")
    fun watches(@AuthenticationPrincipal principal: SessionPrincipal) = service.watches(principal.userId)

    @PostMapping("/api/me/laundry-watches")
    @ResponseStatus(HttpStatus.CREATED)
    fun createWatch(
        @AuthenticationPrincipal principal: SessionPrincipal,
        @Valid @RequestBody value: LaundryWatchInput,
    ) = service.createWatch(principal.userId, value)

    @DeleteMapping("/api/me/laundry-watches/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun deleteWatch(
        @AuthenticationPrincipal principal: SessionPrincipal,
        @PathVariable id: String,
    ) = service.deleteWatch(principal.userId, id)
}
