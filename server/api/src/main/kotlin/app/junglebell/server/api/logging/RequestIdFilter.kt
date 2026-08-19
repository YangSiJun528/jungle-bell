package app.junglebell.server.api.logging

import app.junglebell.server.common.logging.LoggingContext
import jakarta.servlet.FilterChain
import jakarta.servlet.http.HttpServletRequest
import jakarta.servlet.http.HttpServletResponse
import java.util.UUID
import org.springframework.core.Ordered
import org.springframework.core.annotation.Order
import org.springframework.stereotype.Component
import org.springframework.web.filter.OncePerRequestFilter

const val REQUEST_ID_HEADER = "X-Request-ID"

@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
class RequestIdFilter : OncePerRequestFilter() {
    override fun doFilterInternal(
        request: HttpServletRequest,
        response: HttpServletResponse,
        filterChain: FilterChain,
    ) {
        val requestId = request.getHeader(REQUEST_ID_HEADER)
            ?.takeIf(VALID_REQUEST_ID::matches)
            ?: UUID.randomUUID().toString()
        response.setHeader(REQUEST_ID_HEADER, requestId)
        LoggingContext.withRequest(requestId) {
            filterChain.doFilter(request, response)
        }
    }

    private companion object {
        val VALID_REQUEST_ID = Regex("^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$")
    }
}
