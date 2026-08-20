package app.junglebell.server.api.usage

import app.junglebell.server.api.security.CurrentSession
import app.junglebell.server.domain.security.SessionPrincipal
import app.junglebell.server.domain.usage.AnonymousUsageRecorder
import app.junglebell.server.domain.usage.UsageClient
import app.junglebell.server.domain.usage.UsageRecorder
import jakarta.servlet.http.HttpServletRequest
import jakarta.servlet.http.HttpServletResponse
import jakarta.validation.Valid
import jakarta.validation.constraints.Pattern
import java.time.Duration
import org.springframework.http.HttpHeaders
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseCookie
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.ResponseStatus
import org.springframework.web.bind.annotation.RestController

data class AnonymousUiOpenedRequest(
    @field:Pattern(regexp = "web|pwa")
    val client: String,
)

@RestController
class UsageController(
    private val authenticated: UsageRecorder,
    private val anonymous: AnonymousUsageRecorder,
) {
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
        val existing = request.cookies?.firstOrNull { it.name == secureCookieName(request) }?.value
            ?: request.cookies?.firstOrNull { it.name == COOKIE_NAME }?.value
        val client = if (body.client == UsageClient.PWA.value) UsageClient.PWA else UsageClient.WEB
        val identity = anonymous.recordUiOpened(existing, client) ?: return
        if (!identity.newToken) return

        val secure = isSecure(request)
        response.addHeader(
            HttpHeaders.SET_COOKIE,
            ResponseCookie.from(if (secure) "__Host-$COOKIE_NAME" else COOKIE_NAME, identity.token)
                .httpOnly(true)
                .secure(secure)
                .sameSite("Strict")
                .path("/")
                .maxAge(Duration.ofHours(24))
                .build()
                .toString(),
        )
    }

    private fun secureCookieName(request: HttpServletRequest): String =
        if (isSecure(request)) "__Host-$COOKIE_NAME" else COOKIE_NAME

    private fun isSecure(request: HttpServletRequest): Boolean =
        request.isSecure || request.getHeader("X-Forwarded-Proto") == "https"

    private companion object {
        const val COOKIE_NAME = "jb_usage"
    }
}
