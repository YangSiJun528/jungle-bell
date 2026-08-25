package app.junglebell.server.api

import app.junglebell.server.api.account.AccountController
import app.junglebell.server.api.notification.NotificationController
import app.junglebell.server.api.pairing.PairingController
import app.junglebell.server.api.personal.PersonalController
import app.junglebell.server.api.usage.UsageController
import org.junit.jupiter.api.Test
import org.springframework.core.annotation.AnnotatedElementUtils
import org.springframework.web.bind.annotation.RequestMapping
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class AccountApiRouteContractTest {
    @Test
    fun `browser and desktop SPA share one account namespace`() {
        val routes = setOf(
            AccountController::class,
            PersonalController::class,
            PairingController::class,
            NotificationController::class,
            UsageController::class,
        ).flatMap { controller ->
            controller.java.declaredMethods.flatMap { method ->
                AnnotatedElementUtils.findMergedAnnotation(method, RequestMapping::class.java)
                    ?.path
                    ?.toList()
                    .orEmpty()
            }
        }.toSet()

        assertEquals(
            setOf(
                "/api/me/attendance",
                "/api/me/attendance/preferences",
                "/api/me/meal-preferences",
                "/api/me/laundry-watches",
                "/api/me/laundry-watches/{id}",
                "/api/me/pairings",
                "/api/me/pairings/{id}",
                "/api/me/pairings/{id}/approve",
                "/api/me/mobile-sessions",
                "/api/me/mobile-sessions/{id}",
                "/api/me/session",
                "/api/me/notifications",
                "/api/me/notifications/test",
                "/api/me/push/vapid-public-key",
                "/api/me/push/subscriptions",
                "/api/me/push/subscriptions/{id}",
                "/api/me/usage-preference",
                "/api/me/usage/ui-opened",
            ),
            routes.filter { it.startsWith("/api/me/") }.toSet(),
        )
        assertTrue(routes.none { it.startsWith("/api/mobile/") })
        assertTrue(routes.none { it.startsWith("/api/desktop-ui/") })
        assertTrue(routes.none { it.startsWith("/api/push/") })
    }
}
