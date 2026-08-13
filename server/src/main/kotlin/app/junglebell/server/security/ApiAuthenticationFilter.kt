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
            path.startsWith("/api/me/") -> false
            path.startsWith("/api/desktop/") -> false
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
                request.requestURI.startsWith("/api/me/") && hasBearer(request) ->
                    auth.desktopUi(bearer(request), request.getHeader("Origin"))
                request.requestURI.startsWith("/api/me/") -> auth.mobile(mobileCookie(request))
                request.requestURI.startsWith("/api/desktop/") -> auth.desktop(bearer(request))
                else -> throw IllegalStateException("Unexpected authenticated API path")
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

    private fun hasBearer(request: HttpServletRequest): Boolean =
        request.getHeader("Authorization")?.startsWith("Bearer ") == true

    private fun mobileCookie(request: HttpServletRequest): String {
        return request.cookies?.firstOrNull { it.name == "__Host-jb_device" || it.name == "jb_device" }?.value
            ?: throw ApiException("AUTHENTICATION_REQUIRED", org.springframework.http.HttpStatus.UNAUTHORIZED)
    }
}
