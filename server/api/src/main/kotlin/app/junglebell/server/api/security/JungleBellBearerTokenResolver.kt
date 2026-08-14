package app.junglebell.server.api.security

import jakarta.servlet.http.HttpServletRequest
import org.springframework.http.HttpMethod
import org.springframework.security.oauth2.server.resource.web.DefaultBearerTokenResolver
import org.springframework.security.oauth2.server.resource.web.BearerTokenResolver
import org.springframework.stereotype.Component

@Component
class JungleBellBearerTokenResolver : BearerTokenResolver {
    private val headerResolver = DefaultBearerTokenResolver()

    override fun resolve(request: HttpServletRequest): String? {
        if (request.method == HttpMethod.OPTIONS.name()) return null

        val path = request.requestURI
        if (path == "/api/desktop/installations" && request.method == HttpMethod.POST.name()) return null
        if (!path.startsWith("/api/desktop/") && !path.startsWith("/api/me/")) return null

        return headerResolver.resolve(request)
            ?: if (path.startsWith("/api/me/")) mobileCookie(request) else null
    }

    private fun mobileCookie(request: HttpServletRequest): String? =
        request.cookies?.firstOrNull { it.name == "__Host-jb_device" }?.value?.takeIf(String::isNotBlank)
            ?: request.cookies?.firstOrNull { it.name == "jb_device" }?.value?.takeIf(String::isNotBlank)
}
