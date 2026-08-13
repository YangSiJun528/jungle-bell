package app.junglebell.server.security

import app.junglebell.server.common.ApiException
import jakarta.servlet.FilterChain
import jakarta.servlet.http.HttpServletRequest
import jakarta.servlet.http.HttpServletResponse
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken
import org.springframework.security.core.context.SecurityContextHolder
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.stereotype.Component
import org.springframework.web.filter.OncePerRequestFilter
import org.springframework.web.servlet.HandlerExceptionResolver

@Component
class ApiAuthenticationFilter(
    private val auth: AuthService,
    @param:Qualifier("handlerExceptionResolver")
    private val exceptionResolver: HandlerExceptionResolver,
) : OncePerRequestFilter() {
    override fun shouldNotFilter(request: HttpServletRequest): Boolean {
        val path = request.requestURI
        return request.method == "OPTIONS" || when {
            path == "/api/desktop/installations" && request.method == "POST" -> true
            path.startsWith("/api/desktop-ui/") -> false
            path.startsWith("/api/desktop/") -> false
            path.startsWith("/api/mobile/") -> false
            path.startsWith("/api/push/") -> false
            else -> true
        }
    }

    override fun doFilterInternal(
        request: HttpServletRequest,
        response: HttpServletResponse,
        filterChain: FilterChain,
    ) {
        try {
            val principal = when {
                request.requestURI.startsWith("/api/desktop-ui/") ->
                    auth.desktopUi(bearer(request), request.getHeader("Origin"))
                request.requestURI.startsWith("/api/desktop/") -> auth.desktop(bearer(request))
                else -> auth.mobile(mobileCookie(request))
            }
            SecurityContextHolder.getContext().authentication =
                UsernamePasswordAuthenticationToken(principal, null, emptyList())
            filterChain.doFilter(request, response)
        } catch (error: ApiException) {
            exceptionResolver.resolveException(request, response, null, error)
        } finally {
            SecurityContextHolder.clearContext()
        }
    }

    private fun bearer(request: HttpServletRequest): String {
        val match = Regex("^Bearer (\\S+)$").matchEntire(request.getHeader("Authorization") ?: "")
        return match?.groupValues?.get(1)
            ?: throw ApiException("AUTHENTICATION_REQUIRED", org.springframework.http.HttpStatus.UNAUTHORIZED)
    }

    private fun mobileCookie(request: HttpServletRequest): String {
        return request.cookies?.firstOrNull { it.name == "__Host-jb_device" || it.name == "jb_device" }?.value
            ?: throw ApiException("AUTHENTICATION_REQUIRED", org.springframework.http.HttpStatus.UNAUTHORIZED)
    }
}
