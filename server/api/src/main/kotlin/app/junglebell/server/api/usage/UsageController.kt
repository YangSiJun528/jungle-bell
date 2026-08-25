package app.junglebell.server.api.usage

import app.junglebell.server.api.security.CurrentSession
import app.junglebell.server.domain.security.SessionPrincipal
import app.junglebell.server.domain.usage.AnonymousUsageRecorder
import app.junglebell.server.domain.usage.UsageClient
import app.junglebell.server.domain.usage.UsagePreference
import app.junglebell.server.domain.usage.UsagePreferenceService
import app.junglebell.server.domain.usage.UsageRecorder
import jakarta.servlet.http.HttpServletRequest
import jakarta.servlet.http.HttpServletResponse
import jakarta.validation.Valid
import jakarta.validation.constraints.Pattern
import java.time.Duration
import org.springframework.http.HttpHeaders
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseCookie
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.PutMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.ResponseStatus
import org.springframework.web.bind.annotation.RestController

data class AnonymousUiOpenedRequest(
    @field:Pattern(regexp = "web|pwa")
    val client: String,
)

data class UsagePreferenceRequest(val enabled: Boolean)

@RestController
class UsageController(
    private val authenticated: UsageRecorder,
    private val anonymous: AnonymousUsageRecorder,
    private val preferences: UsagePreferenceService,
) {
    @GetMapping("/api/me/usage-preference", "/api/desktop/usage-preference")
    fun usagePreference(@CurrentSession principal: SessionPrincipal): UsagePreference =
        preferences.get(principal.userId)

    @PutMapping("/api/desktop/usage-preference")
    fun putUsagePreference(
        @CurrentSession principal: SessionPrincipal,
        @Valid @RequestBody body: UsagePreferenceRequest,
    ): UsagePreference = preferences.put(principal.userId, body.enabled)

    @GetMapping("/api/public/usage-preference")
    fun anonymousUsagePreference(
        request: HttpServletRequest,
        response: HttpServletResponse,
    ): UsagePreference {
        response.setHeader(HttpHeaders.CACHE_CONTROL, "no-store")
        return UsagePreference(enabled = !hasAnonymousOptOut(request))
    }

    @PutMapping("/api/public/usage-preference")
    fun putAnonymousUsagePreference(
        @Valid @RequestBody body: UsagePreferenceRequest,
        request: HttpServletRequest,
        response: HttpServletResponse,
    ): UsagePreference {
        response.setHeader(HttpHeaders.CACHE_CONTROL, "no-store")
        if (body.enabled) {
            expireCookies(response, request, ANONYMOUS_OPT_OUT_COOKIE_NAME)
        } else {
            setCookie(
                response,
                cookieName(request, ANONYMOUS_OPT_OUT_COOKIE_NAME),
                "1",
                isSecure(request),
                ANONYMOUS_OPT_OUT_MAX_AGE,
            )
            expireCookies(response, request, COOKIE_NAME)
        }
        return UsagePreference(body.enabled)
    }

    @PostMapping("/api/me/usage/ui-opened")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun authenticatedUiOpened(@CurrentSession principal: SessionPrincipal) {
        authenticated.recordUiOpened(principal)
    }

    @PostMapping("/api/public/usage/ui-opened")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun anonymousUiOpened(
        @Valid @RequestBody body: AnonymousUiOpenedRequest,
        request: HttpServletRequest,
        response: HttpServletResponse,
    ) {
        if (hasAnonymousOptOut(request)) return
        val existing = request.cookies?.firstOrNull { it.name == secureCookieName(request) }?.value
            ?: request.cookies?.firstOrNull { it.name == COOKIE_NAME }?.value
        val client = if (body.client == UsageClient.PWA.value) UsageClient.PWA else UsageClient.WEB
        val identity = anonymous.recordUiOpened(existing, client) ?: return
        if (!identity.newToken) return

        val secure = isSecure(request)
        setCookie(
            response,
            cookieName(request, COOKIE_NAME),
            identity.token,
            secure,
            Duration.ofHours(24),
        )
    }

    private fun secureCookieName(request: HttpServletRequest): String =
        cookieName(request, COOKIE_NAME)

    private fun hasAnonymousOptOut(request: HttpServletRequest): Boolean =
        request.cookies?.any {
            (it.name == ANONYMOUS_OPT_OUT_COOKIE_NAME ||
                it.name == "__Host-$ANONYMOUS_OPT_OUT_COOKIE_NAME")
        } == true

    private fun cookieName(request: HttpServletRequest, baseName: String): String =
        if (isSecure(request)) "__Host-$baseName" else baseName

    private fun expireCookies(
        response: HttpServletResponse,
        request: HttpServletRequest,
        baseName: String,
    ) {
        setCookie(response, baseName, "", secure = false, maxAge = Duration.ZERO)
        if (isSecure(request)) {
            setCookie(response, "__Host-$baseName", "", secure = true, maxAge = Duration.ZERO)
        }
    }

    private fun setCookie(
        response: HttpServletResponse,
        name: String,
        value: String,
        secure: Boolean,
        maxAge: Duration,
    ) {
        response.addHeader(
            HttpHeaders.SET_COOKIE,
            ResponseCookie.from(name, value)
                .httpOnly(true)
                .secure(secure)
                .sameSite("Strict")
                .path("/")
                .maxAge(maxAge)
                .build()
                .toString(),
        )
    }

    private fun isSecure(request: HttpServletRequest): Boolean =
        request.isSecure || request.getHeader("X-Forwarded-Proto") == "https"

    private companion object {
        const val COOKIE_NAME = "jb_usage"
        const val ANONYMOUS_OPT_OUT_COOKIE_NAME = "jb_usage_opt_out"
        val ANONYMOUS_OPT_OUT_MAX_AGE: Duration = Duration.ofDays(365)
    }
}
