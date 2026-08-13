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
    @GetMapping(
        "/api/desktop-ui/attendance/preferences",
        "/api/desktop/attendance/preferences",
        "/api/mobile/attendance/preferences",
    )
    fun attendance(@AuthenticationPrincipal principal: SessionPrincipal) = service.attendance(principal.userId)

    @PutMapping(
        "/api/desktop-ui/attendance/preferences",
        "/api/desktop/attendance/preferences",
        "/api/mobile/attendance/preferences",
    )
    fun updateAttendance(
        @AuthenticationPrincipal principal: SessionPrincipal,
        @Valid @RequestBody value: AttendancePreferences,
    ) = service.updateAttendance(principal.userId, value)

    @GetMapping(
        "/api/desktop-ui/meal-preferences",
        "/api/desktop/meal-preferences",
        "/api/mobile/meal-preferences",
    )
    fun meal(@AuthenticationPrincipal principal: SessionPrincipal) = service.meal(principal.userId)

    @PutMapping(
        "/api/desktop-ui/meal-preferences",
        "/api/desktop/meal-preferences",
        "/api/mobile/meal-preferences",
    )
    fun updateMeal(
        @AuthenticationPrincipal principal: SessionPrincipal,
        @Valid @RequestBody value: MealPreferencesInput,
    ) = service.updateMeal(principal.userId, value)

    @GetMapping(
        "/api/desktop-ui/laundry-watches",
        "/api/desktop/laundry-watches",
        "/api/mobile/laundry-watches",
    )
    fun watches(@AuthenticationPrincipal principal: SessionPrincipal) = service.watches(principal.userId)

    @PostMapping(
        "/api/desktop-ui/laundry-watches",
        "/api/desktop/laundry-watches",
        "/api/mobile/laundry-watches",
    )
    @ResponseStatus(HttpStatus.CREATED)
    fun createWatch(
        @AuthenticationPrincipal principal: SessionPrincipal,
        @Valid @RequestBody value: LaundryWatchInput,
    ) = service.createWatch(principal.userId, value)

    @DeleteMapping(
        "/api/desktop-ui/laundry-watches/{id}",
        "/api/desktop/laundry-watches/{id}",
        "/api/mobile/laundry-watches/{id}",
    )
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun deleteWatch(
        @AuthenticationPrincipal principal: SessionPrincipal,
        @PathVariable id: String,
    ) = service.deleteWatch(principal.userId, id)
}
