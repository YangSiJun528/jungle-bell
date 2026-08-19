package app.junglebell.server.api.logging

import app.junglebell.server.common.logging.LoggingContext
import app.junglebell.server.domain.security.SessionPrincipal
import jakarta.servlet.FilterChain
import jakarta.servlet.http.HttpServletRequest
import jakarta.servlet.http.HttpServletResponse
import org.springframework.security.core.context.SecurityContextHolder
import org.springframework.security.oauth2.core.OAuth2AuthenticatedPrincipal
import org.springframework.web.filter.OncePerRequestFilter

class AuthenticatedUserMdcFilter : OncePerRequestFilter() {
    override fun doFilterInternal(
        request: HttpServletRequest,
        response: HttpServletResponse,
        filterChain: FilterChain,
    ) {
        val session = (SecurityContextHolder.getContext().authentication?.principal as? OAuth2AuthenticatedPrincipal)
            ?.getAttribute<SessionPrincipal>("session")
        if (session == null) {
            filterChain.doFilter(request, response)
            return
        }
        LoggingContext.withUser(session.userId.toString()) {
            filterChain.doFilter(request, response)
        }
    }
}
